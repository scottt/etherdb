var net = require( 'net' );
var async = require( 'async' );
var pg = require( 'pg' );
var conString = "postgres://etherwriter:password@localhost/etherdb";
var Web3 = require( 'web3' );
var web3 = new Web3();
var username = require( 'username' );
var sleep = require( 'sleep' );
var client;
var ipc_path = process.env.ETH_IPC_PATH || '/home/' + username.sync() + '/.ethereum/geth.ipc';

function mapValue( p, source ) {
  var result = source[p];

  if ( ['number', 'size', 'nonce', 'gasLimit', 'gasUsed', 'difficulty',
        'totalDifficulty', 'blockNumber', 'transactionIndex', 'value',
        'gas', 'gasPrice'].indexOf( p ) >= 0 ) {
    return Number(result);
  }

  if ( ['timestamp'].indexOf( p ) >= 0 ) {
    return new Date(Number(result) * 1000);
  }

  return String(result);
}

function writeToDb( source, table, callback ) {
  var fields = [];
  var params = [];
  var values = [];

  var i = 1;
  for ( var p in source ) {
    // skip internals for now
    if ( ['transactions', 'uncles'].indexOf(p) >= 0 ) {
      continue;
    }

    fields.push( '"' + p.toLowerCase() + '"' );
    values.push( mapValue( p, source ) );
    params.push( '$' + i++ );
  }

  var sql = 'INSERT INTO ' + table + '(' + fields.join(',') + ')\nVALUES(' + params.join(',')+ ')';

  client.query(sql, values, function(err, result) {
    if( err ) {
      console.error( sql );
      console.error( values );
      return callback( err );
    }
    callback( null, result );
  });
}

function processDetails( block, table, callback ) {
  async.each( block[table], function ( d, done ) {
    if ( table == 'uncles' ) {
      d = { hash: d, blockNumber: block.number }; // we need this in the DB for uncles
    }

    writeToDb( d, table, done );
  }, function ( err ) {
    return callback( err ) ;
  } );
}

function getBlock( err, num, callback ) {
  web3.eth.getBlock(num, true, function( err, block ) {
    if ( err ) {
      return callback( err );
    }

    if ( !block ) {
      return callback();
    }

    console.log( block.number );

    writeToDb( block, 'blocks', function( err, result ) {
      if ( err ) {
        return callback( err );
      }

      async.parallel( [
        function ( cb ) {
          processDetails( block, 'transactions', cb );
        },
        function ( cb ) {
          processDetails( block, 'uncles', cb );
        }
      ], function ( err, result ) {
        if ( err ) {
          return callback( err );
        }
        getBlock( null, num + 1, callback );
      } );
    } );
  } );
}

pg.connect(conString, function(err, c, done) {
  if ( err ) {
    return done( err );
  }

  client = c;
  web3.setProvider(new web3.providers.IpcProvider(ipc_path, net));
  var gb_error;

  function getBlocks( callback ) {
    var sql = 'SELECT COALESCE(lb.number, -1) AS max FROM view_last_block lb';
    client.query(sql, [], function( err, result ) {
      if( err ) {
        return callback ( err );
      }

      var fromBlock = (result && result.rows && result.rows.length) ? Number(result.rows[0].max) + 1 : 0;
      console.log( 'Resuming from block: ' + fromBlock );
      getBlock( null, fromBlock, function ( err ) {
        if ( err ) {
          return callback( err );
        }

        console.log( 'Done batch, sleeping 20s' );
        sleep.sleep( 20 );
        return callback();
      } );
    } );
  }

  async.whilst(
    function () {
      return !gb_error;
    },
    getBlocks,
    function ( err, n ) {
      done( err );
      if ( err ) {
        gb_error = err;
        console.error( err, n );
      }
    }
  );
} );
