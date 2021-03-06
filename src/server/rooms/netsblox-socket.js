/*
 * This is a socket for NetsBlox that wraps a standard WebSocket
 */
'use strict';
var counter = 0,
    Constants = require(__dirname + '/../../common/constants'),
    PublicRoleManager = require(__dirname + '/../public-role-manager'),
    PROJECT_FIELDS = [
        'ProjectName',
        'SourceCode',
        'Media',
        'SourceSize',
        'MediaSize',
        'RoomUuid'
    ],
    R = require('ramda'),
    parseXml = require('xml2js').parseString,
    assert = require('assert'),
    UserActions = require('../storage/user-actions'),
    RoomManager = require('./room-manager'),
    CONDENSED_MSGS = ['project-response', 'import-room'];

var createSaveableProject = function(json, callback) {
    var project = R.pick(PROJECT_FIELDS, json);
    // Set defaults
    project.Public = false;
    project.Updated = new Date();

    // Add the thumbnail,notes from the project content
    var inProjectSource = ['Thumbnail', 'Notes'];

    parseXml(project.SourceCode, (err, jsonSrc) => {
        if (err) {
            return callback(err);
        }

        inProjectSource.forEach(field => {
            project[field] = jsonSrc.project[field.toLowerCase()];
        });
        callback(null, project);
    });
};

class NetsBloxSocket {
    constructor (logger, socket) {
        var id = ++counter;
        this.id = id;
        this.uuid = '_client_'+id;
        this._logger = logger.fork(this.uuid);

        this.roleId = null;
        this._room = null;
        this.loggedIn = false;

        this.user = null;
        this.username = this.uuid;
        this._socket = socket;
        this._projectRequests = {};  // saving
        this._initialize();

        // Provide a uuid
        this.send({type: 'uuid', body: this.uuid});
        this.onclose = [];

        this._logger.trace('created');
    }


    hasRoom (silent) {
        if (!this._room && !silent) {
            this._logger.error('user has no room!');
        }
        return !!this._room;
    }

    isOwner () {
        return this._room && this._room.owner.username === this.username;
    }

    _initialize () {
        this._socket.on('message', data => {
            var msg = JSON.parse(data),
                type = msg.type;

            this._logger.trace(`received "${CONDENSED_MSGS.indexOf(type) !== -1 ? type : data}" message`);
            if (NetsBloxSocket.MessageHandlers[type]) {
                NetsBloxSocket.MessageHandlers[type].call(this, msg);
            } else {
                this._logger.warn('message "' + data + '" not recognized');
            }
        });

        this._socket.on('close', () => {
            this._logger.trace('closed!');
            if (this._room) {
                this.leave();
            }
            this.onclose.forEach(fn => fn.call(this));
            this.onClose(this.uuid);
        });
    }

    onLogin (user) {
        this._logger.log('logged in as ' + user.username);
        this.username = user.username;
        this.user = user;
        this.loggedIn = true;

        // Update the user's room name
        if (this._room) {
            this._room.update();
            if (this._room.roles[this.roleId] === this) {
                this._room.updateRole(this.roleId);
            }
        }
    }

    join (room, role) {
        role = role || this.roleId;
        this._logger.log(`joining ${room.uuid}/${role} from ${this.roleId}`);
        if (this._room === room && role !== this.roleId) {
            return this.changeSeats(role);
        }

        this._logger.log(`joining ${room.uuid}/${role} from ${this.roleId}`);
        if (this._room && this._room.uuid !== room.uuid) {
            this.leave();
        }

        this._room = room;
        this._room.add(this, role);
        this._logger.trace(`${this.username} joined ${room.uuid} at ${role}`);
        this.roleId = role;
    }

    getNewName (name) {
        if (this.user) {
            name = this.user.getNewName(name);
        } else {
            name = 'New Room ' + (Date.now() % 100);
        }

        this._logger.info(`generated unique name for ${this.username} - ${name}`);
        return name;
    }

    newRoom (opts) {
        var name,
            room;

        opts = opts || {role: 'myRole'};
        name = opts.room || opts.name || this.getNewName();
        this._logger.info(`"${this.username}" is making a new room "${name}"`);

        room = RoomManager.createRoom(this, name);
        room.createRole(opts.role);
        this.join(room, opts.role);
    }

    // This should only be called internally *EXCEPT* when the socket is going to close
    leave () {
        this._room.roles[this.roleId] = null;

        if (this.isOwner() && this._room.ownerCount() === 0) {  // last owner socket closing
            this._room.close();
        } else {
            this._room.onRolesChanged();
            RoomManager.checkRoom(this._room);
        }
    }

    changeSeats (role) {
        this._logger.log(`changing to role ${this._room.uuid}/${role} from ${this.roleId}`);
        this._room.move({socket: this, dst: role});
        assert.equal(this.roleId, role);
    }

    sendToOthers (msg) {
        this._room.sendFrom(this, msg);
    }

    sendToEveryone (msg) {
        this._room.sendToEveryone(msg);
    }

    send (msg) {
        // Set the defaults
        msg.type = msg.type || 'message';
        if (msg.type === 'message') {
            msg.dstId = msg.dstId || Constants.EVERYONE;
        }

        msg = JSON.stringify(msg);
        this._logger.trace(`Sending message to ${this.uuid} "${msg}"`);
        if (this._socket.readyState === this.OPEN) {
            this._socket.send(msg);
        } else {
            this._logger.log('could not send msg - socket no longer open');
        }
    }

    getState () {
        return this._socket.readyState;
    }

    getProjectJson (callback) {
        var id = ++counter;
        this.send({
            type: 'project-request',
            id: id
        });
        this._projectRequests[id] = callback;
    }
}

// From the WebSocket spec
NetsBloxSocket.prototype.CONNECTING = 0;
NetsBloxSocket.prototype.OPEN = 1;
NetsBloxSocket.prototype.CLOSING = 2;
NetsBloxSocket.prototype.CLOSED = 3;

NetsBloxSocket.MessageHandlers = {
    'beat': function() {},

    'message': function(msg) {
        if (!this.hasRoom()) {
            this._logger.error(`Cannot send a message when not in a room! ${this.username} (${this.uuid})`);
            return;
        }

        if (msg.dstId === 'others in room' || msg.dstId === Constants.EVERYONE ||
            this._room.roles.hasOwnProperty(msg.dstId)) {  // local message

            msg.dstId === 'others in room' ? this.sendToOthers(msg) : this.sendToEveryone(msg);
        } else {  // inter-room message
            var socket = PublicRoleManager.lookUp(msg.dstId);
            if (socket) {
                msg.dstId = Constants.EVERYONE;
                socket.send(msg);
            }
        }
    },

    'project-response': function(msg) {
        var id = msg.id,
            json = msg.project;

        createSaveableProject(json, (err, project) => {
            if (err) {
                var msg = [
                    `Could not create saveable project for ${this.roleId} from `,
                    `${JSON.stringify(json)} (${err.toString()})`
                ].join('');
                this._logger.error(msg);
                this._projectRequests[id].call(null, err);
                delete this._projectRequests[id];
                return;
            }

            if (!project) {  // silent failure
                err = `Received falsey project! ${JSON.stringify(project)}`;
                this._logger.error(err);
                this._projectRequests[id].call(null, err);
                delete this._projectRequests[id];
                return;
            }

            this._logger.log('created saveable project for request ' + id);
            this._projectRequests[id].call(null, null, project);
            delete this._projectRequests[id];
        });
    },

    'rename-room': function(msg) {
        if (this.isOwner()) {
            this._room.update(msg.name);
        }
    },

    'rename-role': function(msg) {
        var socket;
        if (this.isOwner() && msg.roleId !== msg.name) {
            this._room.renameRole(msg.roleId, msg.name);

            socket = this._room.roles[msg.name];
            if (socket) {
                socket.send(msg);
            }
        }
    },

    'request-room-state': function() {
        if (this.hasRoom()) {
            var msg = this._room.getStateMsg();
            this.send(msg);
        }
    },

    'create-room': function(msg) {
        this.newRoom(msg);
    },

    'join-room': function(msg) {
        var owner = msg.owner,
            name = msg.room,
            role = msg.role;

        RoomManager.getRoom(this, owner, name, (room) => {
            if (!room) {
                this._logger.error(`Could not join room ${name} - doesn't exist!`);
                return;
            }
            // Check if the user is already at the room
            if (this._room === room) {
                this._logger.warn(`${this.username} is already in ${name}! ` +
                    ` Switching roles instead of "join-room" for ${room.uuid}`);
                return this.changeSeats(role);
            }

            // create the role if need be (and if we are the owner)
            if (!room.roles.hasOwnProperty(role) && room.owner === this) {
                this._logger.info(`creating role ${role} at ${room.uuid}`);
                room.createRole(role);
            }
            return this.join(room, role);
        });
        
    },

    'add-role': function(msg) {
        // TODO: make sure this is the room owner
        if (this.hasRoom()) {
            this._room.createRole(msg.name);
        }
    },

    ///////////// Import/Export /////////////
    'import-room': function(msg) {
        var roles = Object.keys(msg.roles),
            names = {},
            name,
            i = 2;

        if (!this.hasRoom()) {
            this._logger.error(`${this.username} has no associated room`);
            return;
        }

        // change the socket's name to the given name (as long as it isn't colliding)
        if (this.user) {
            this.user.rooms.forEach(room => names[room.name] = true);
        }

        // create unique name, if needed
        name = msg.name;
        while (names[name]) {
            name = msg.name + ' (' + i + ')';
            i++;
        }

        this._logger.trace(`changing room name from ${this._room.name} to ${name}`);
        this._room.update(name);

        // Rename the socket's role
        this._logger.trace(`changing role name from ${this.roleId} to ${msg.role}`);
        this._room.renameRole(this.roleId, msg.role);

        // Add all the additional roles
        this._logger.trace(`adding roles: ${roles.join(',')}`);
        roles.forEach(role => this._room.silentCreateRole(role));

        // load the roles into the cache
        roles.forEach(role => this._room.cachedProjects[role] = {
            SourceCode: msg.roles[role].SourceCode,
            Media: msg.roles[role].Media,
            MediaSize: msg.roles[role].Media.length,
            SourceSize: msg.roles[role].SourceCode.length,
            RoomName: msg.name
        });

        this._room.onRolesChanged();
    },

    // Retrieve the json for each project and respond
    'export-room': function(msg) {
        if (this.hasRoom()) {
            this._room.collectProjects((err, projects) => {
                if (err) {
                    this._logger.error(`Could not collect projects from ${this._room.name}`);
                    return;
                }
                this._logger.trace(`Exporting projects for ${this._room.name}` +
                    ` to ${this.username}`);

                this.send({
                    type: 'export-room',
                    roles: projects,
                    action: msg.action
                });
            });
        }
    },

    'request-new-name': function() {
        if (this.hasRoom()) {
            this._room.name = null;
            this._room.changeName();  // get unique base name
        } else {
            this._logger.warn(`Cannot req new name w/o a room! (${this.username})`);
        }
    },
     
    'share-msg-type': function(msg) {
        this.sendToEveryone(msg);
    },

    // message for recording user actions
    'record-action': function(msg) {
        var sessionId = this.uuid + '/' + msg.sessionId,  // unique for the given editing session
            projectId = 'n/a',
            record = {};

        if (this.hasRoom()) {
            projectId = this._room.uuid;
        }

        record.username = this.username === this.uuid ? 'n/a' : this.username;
        record.sessionId = sessionId;
        record.projectId = projectId;
        record.action = msg.action;

        UserActions.record(record);  // Store action in the database by sessionId
    }
};

module.exports = NetsBloxSocket;
