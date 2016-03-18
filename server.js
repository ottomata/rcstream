#!/usr/bin/env node
/**
 * Broadcast MediaWiki recent changes over WebSockets with Socket.IO
 *
 * To enable debug output, use --debug or set `DEBUG=rcstream`.
 * To enable debug from socket.io, use --verbose or set `DEBUG=*`.
 *
 * See <https://wikitech.wikimedia.org/wiki/RCStream> for more.
 *
 * Copyright 2014 Ori Livneh <ori@wikimedia.org>
 * Copyright 2016 Timo Tijhof <krinklemail@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var yargs = require('yargs');
var debug = require('debug');

var rcstream = (function() {
  var regexCache = {};
  var hasOwn = regexCache.hasOwnProperty;

  function escape(str) {
    return str.replace(/([.+?=^!:${}()|[\]\/\\])/g, '\\$1');
  }

  function makeMatchRegex(pattern) {
    if (!hasOwn.call(regexCache, pattern)) {
      regexCache[pattern] = new RegExp(
        '^' + escape(pattern).replace(/\*/g, '.*') + '$'
      );
    }
    return regexCache[pattern];
  }

  /**
   * Test a collection of wildcard patterns against a string.
   *
   * @param {string} str
   * @param {string[]} patterns
   */
  function matchAny(str, patterns) {
    for (var r, i = 0; i < patterns.length; i++) {
      r = makeMatchRegex(patterns[i]);
      if (r.test(str)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sort an array based on a computed sort key. Like python's array.sort(key=).
   *
   * @param {Array} list
   * @param {Function} sortKey Provides the sort key
   */
  function keySort(list, sortKey) {
    list.sort(function(a, b) {
      return sortKey(a) - sortKey(b);
    });
  }

  /**
   * Sort key for subscriptions that puts shorter wildcard patterns ahead.
   * NB: Contrary to python-rcstream#subscription_sort_key this always sorts
   * wildcards before short ones, instead of treating them with equal priority.
   *
   * @return {number}
   */
  function subSortKey(value) {
    return value.indexOf('*') !== -1 ? 0 : value.length;
  }

  return function(serverPort, zookeeperConnect, topic) {
    // default topic is 'rcstream'
    topic = topic || 'rcstream'

    var MAX_SUBSCRIPTIONS = 10;
    var server = require('http').createServer();
    var namespace = require('socket.io')(server).of('/rc');
    var kafka = require('kafka-node');


    var log = debug('rcstream:main');
    var debugKafka = debug('rcstream:kafka');
    var subscriptionStore = {};

    server.listen(serverPort);
    log('Listening on port %d', serverPort);
    setTimeout(function() {
        log('Waiting 2 seconds for websocket clients to reconnect');
    }, 2000);
    log('Connecting to zookeeper at %s', zookeeperConnect);

    // Set up Kafka Consumer
    // TODO: Wait for websocket clients to reconnect, as consumption
    // will happen faster, and clients may miss messages.
    var kafkaClient = new kafka.Client(zookeeperConnect, 'rcstream')
    var kafkaConsumer = new kafka.HighLevelConsumer(
      kafkaClient,
      [
          { topic: topic }
      ],
      {
        autoCommit: true,
        autoCommitIntervalMs: 1000,
        groupId: 'rcstream',
      }
    );


    kafkaConsumer.on('error', function() {
      log('Kafka error %o', arguments);
      process.exit(1);
    });

    // Consume message from kafka and send to ws client
    kafkaConsumer.on('message', function(message) {
      var change, wiki, id, subscriptions;
      try {
        change = JSON.parse(message.value);
      } catch (e) {
        log('Failed to decode: %o', message.value);
        return;
      }
      debugKafka('message %o', arguments);

      wiki = change.server_name;

      // Send this message to socket.io clients that want it.
      for (id in namespace.connected) {
        subscriptions = subscriptionStore[id];
        if (subscriptions && matchAny(wiki, subscriptions)) {
          namespace.connected[id].emit('change', change);
        }
      }
    });

    // Provide a map with server metrics
    server.on('request', function(req, resp) {
      if (req.url === '/rcstream_status') {
        resp.writeHead(200, { 'Content-Type': 'application/json' });
        resp.write(JSON.stringify({
          connected_clients: Object.keys(namespace.connected).length,
        }, null, 2));
        resp.end();
        return;
      }
    });

    // Handle socket.io clients
    namespace.on('connection', function(socket) {
      var subscriptions = subscriptionStore[socket.id] = [];
      socket.on('subscribe', function(wikis) {
        var i, wiki;
        if (!Array.isArray(wikis)) {
          wikis = [wikis];
        }
        i = wikis.length;
        while (i--) {
          wiki = wikis[i];
          if (typeof wiki !== 'string') {
            continue;
          }
          if (subscriptions.indexOf(wiki) !== -1) {
            continue;
          }
          if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
            socket.error('subscribe_error');
            return;
          }
          subscriptions.push(wiki);
          keySort(subscriptions, subSortKey);
        }
      })
      .on('unsubscribe', function(wikis) {
        var i, idx;
        if (!Array.isArray(wikis)) {
          wikis = [wikis];
        }
        i = wikis.length;
        while (i--) {
          idx = subscriptions.indexOf(wikis[i]);
          if (idx !== -1) {
            // Remove from list
            subscriptions.splice(idx, 1);
          }
        }
      })
      .on('disconnect', function() {
        // Clean up
        delete subscriptionStore[socket.id];
      });
    });


    // TODO: This doesn't seem to work.
    // I want Zookeeper to know that this consumer
    // has shut down properly.

    // Handle SIGINT to close Kafka consumers nicely
    process.on('SIGINT', function() {
        log('Caught interrupt signal');
        kafkaConsumer.close(true, function() {
          kafkaClient.close(function() {
            process.exit();
          });
        });

        process.exit();
    });
  };
}());

var arg = yargs.usage('Usage: $0 [options]')
  .option('zookeeper-connect', {
    desc: 'Zookeeper connect string used to look up Kafka connection information',
    default: 'localhost:2181',
  })
  .option('server-port', {
    desc: 'Port for socket.io server to listen on',
    default: 3000,
  })
  .option('debug', {
    desc: 'Enable debug output',
    boolean: true,
  })
  .option('verbose', {
    desc: 'Enable verbose debug output',
    alias: 'v', boolean: true,
  })
  .help()
  .epilog(
    'Broadcast MediaWiki recent changes over WebSockets.\n' +
    'See <https://wikitech.wikimedia.org/wiki/RCStream> for more.'
  )
  .argv;

if (arg.verbose) {
  debug.enable('*');
} else if (arg.debug) {
  debug.enable('rcstream:*');
} else {
  debug.enable('rcstream:main');
}

rcstream(arg['server-port'], arg['zookeeper-connect']);
