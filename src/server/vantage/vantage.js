// Vantage support for the server object
'use strict';

var vantage = require('vantage')(),
    chalk = require('chalk'),
    repl = require('vantage-repl'),
    R = require('ramda'),
    Query = require('../../common/data-query'),
    fs = require('fs'),
    banner,
    CONNECTED_STATE = [
        'CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'
    ],
    CONSTANTS = require('../../common/constants'),
    RoomManager = require('../rooms/room-manager'),
    SocketManager = require('../socket-manager'),
    UserActions = require('../storage/user-actions'),
    NO_USER_LABEL = '<vacant>';

// Set the banner
banner = ['\n'+
    '#####################################################',
    '#                                                   #',
    '#                 NetsBlox Server                   #',
    '#                                                   #',
    '#####################################################']
    .join('\n');

var NetsBloxVantage = function(server) {
    this.initRoomManagement(server);

    // get user info
    vantage
        .command('user [username]', 'Get info about a specific user')
        .option('-r, --rooms', 'Get the user\'s saved rooms')
        .option('-a, --admin', 'Toggle admin status')
        .option('-u, --update', 'Update the user\'s schema')
        .option('-c, --clear', 'Clear the room info')
        .option('-e [project]', 'Save user project to file')
        .option('-p, --password <password>', 'Set the user password')
        .alias('u')
        .action((args, cb) => {
            var username = args.username;

            if (!username) {  // print all usernames
                console.log('All known users:');
                server.storage.users.names()
                    .then(names => console.log(names.sort()
                        // Should not have multiple counts for a user!
                        .reduce((counts, name) => {
                            var pair = counts[0];
                            if (pair && pair[0] === name) {
                                pair[1]++;
                            } else {
                                counts.unshift([name, 1]);
                            }
                            return counts;
                        }, [])
                        .map(pair => pair[0] + (pair[1] > 1 ? ` (${pair[1]})` : ''))
                        .join('\n')))
                    .then(cb);
            } else {
                server.storage.users.get(username, function(err, user) {
                    if (err) {
                        return cb(err);
                    }
                    if (!user) {
                        console.log('user does not exist!');
                        return cb();
                    }
                    if (args.options.rooms) {
                        console.log(user.pretty().rooms);
                    } else if (args.options.e) {
                        var name = args.options.e,
                            room = user.rooms.find(room => room.name === name),
                            saveable;

                        if (room) {
                            saveable = `<room name="${name}">` +
                                // Create role/project info
                                Object.keys(room.roles).map(role => [
                                    `<role name="${role}">`,
                                    room.roles[role].SourceCode || '',
                                    room.roles[role].Media || '',
                                    `</role>`
                                ].join('\n')) +
                                `</room>`;

                            fs.writeFile(name + '.xml', saveable, err => {
                                if (err) {
                                    return cb(err);
                                }
                                console.log(`saved ${name} to ${name}.xml`);
                                cb();
                            });
                        } else {
                            console.log(`Could not find room "${name}"`);
                        }

                    } else if (args.options.update) {
                        user.rooms = user.rooms || user.projects || [];
                        delete user.projects;
                        user.save();
                        console.log('User updated!');
                    } else if (args.options.clear) {
                        user.rooms = [];
                        user.save();
                        console.log('User updated!');
                    } else if (args.options.admin) {
                        user.admin = !user.admin;
                        user.save();
                        console.log(`User "${user.username}" ${user.admin ? 'now has' :
                            'no longer has'} admin priviledges!`);
                    } else if (args.options.password) {
                        delete user.hash;
                        user.password = args.options.password;
                        user.save();
                        console.log(`Set password to "${args.options.password}"`);
                    } else {
                        console.log(user.pretty());
                    }
                    cb();
                });
            }
        });

    // set DEBUG level FIXME
    vantage
        .command('debug <level>', 'Set the debug level')
        .action(function(args, cb) {
            var level = args.level;
            if (level === 'on') {
                level = 'NetsBlox:*';
            } else if (level === 'off') {
                level = '';
            }

            process.env.DEBUG = level;
            return cb();
        });

    // Expose variables for easy debugging
    global.server = server;

    // User Action Data
    vantage
        .command('sessions', 'Query the recorded user sessions')
        .option('-l, --long', 'List additional metadata about the sessions')
        .option('--clear', 'Clear the user data records')
        .action((args, cb) => {
            UserActions.sessions()
                .then(sessions => Query.listSessions(sessions, args.options))
                .then(() => cb());
        });

    vantage
        .command('session <uuid>', 'Query the recorded user session')
        .option('-e, --export', 'Export the given session actions')
        .action((args, cb) => {
            return Query.printSessions([args.uuid], args.options)
                .then(() => cb());
        });
};

NetsBloxVantage.prototype.initRoomManagement = function(server) {
    vantage
        .command('rooms', 'List all active rooms')
        .option('-e, --entries', 'List the entries from the manager')
        .option('-l, --long', 'Display long format')
        .alias('rs')
        //.option('--with-names', 'Include the group names')
        .action(function(args, cb) {
            // Get all groups
            var header = '* * * * * * * Rooms * * * * * * * \n',
                rooms = R.values(RoomManager.rooms),
                text = rooms.map(function(room) {
                    var clients = Object.keys(room.roles)
                        .map(role => {
                            let client = room.roles[role],
                                username = client ? client.username : NO_USER_LABEL;

                            if (args.options.long && client) {
                                username = `${username} (${client.uuid})`;
                            }

                            return `\t${role}: ${username}`;
                        });

                    return `${room.uuid}:\n${clients.join('\n')}\n`;
                }).join('\n');

            if (args.options.entries) {
                text = Object.keys(RoomManager.rooms).join('\n');
            }
            console.log(header+text);
            return cb();
        });

    vantage
        .command('room <uuid>', 'Look up room info from global database')
        .alias('r')
        .action((args, cb) => {
            server.storage.rooms.get(args.uuid, (err, room) => {
                if (err || !room) {
                    return cb(err || 'Room not found');
                }
                var prettyRoom = room.pretty();
                console.log(prettyRoom);
                cb();
            });
        });

    // Check socket status
    vantage
        .command('check <uuid>', 'Check the connectivity of the given socket')
        .alias('c')
        .option('-d, --domain', 'Get the domain of the given socket')
        .option('-s, --state', 'Get the state of the given socket')
        .option('-a, --all-keys', 'Dump all keys of the given socket')
        .option('-k, --key', 'Get the key value of the given socket')
        .action(function(args, cb) {
            // Get all groups
            var result = '',
                checkSocket = NetsBloxVantage.checkSocket.bind(null, args);

            if (args.uuid === 'all') {
                result = Object.keys(SocketManager.sockets).map(function(uuid) {
                    var socket = SocketManager.sockets[uuid];
                    return `${uuid} (${socket.username}):  ${checkSocket(socket)}`;
                }).join('\n');

            } else {
                var socket = SocketManager.sockets[args.uuid];
                result = checkSocket(socket);
            }
            console.log(result);
            return cb();
        });
};


NetsBloxVantage.checkSocket = function(args, nbSocket) {
    var socket = nbSocket._socket,
        result = null;

    if (!socket) {
        result = 'socket not found';
    } else {
        if (args.options.domain) {
            result = socket.domain;
        } else if (args.options.allkeys) {
            result = Object.keys(socket);
        } else if (args.options.key) {
            result = socket[args.options.key];
        } else {  // default to state
            var state = socket.readyState;
            result = CONNECTED_STATE[state];
        }
    }
    return result;
};

NetsBloxVantage.prettyPrintGroup = function(group) {
    var text = group.name+':\n'+
        group.groups
        .map(function(group) {
            return '  '+group.join(' ');
        })
        .join('\n');
    return text;
};

NetsBloxVantage.prototype.start = function(port) {
    vantage
        .banner(banner)
        .delimiter(chalk.white('netsblox~$'))
        .listen(port || 1234)
        .use(repl)
        .show();
};

module.exports = NetsBloxVantage;
