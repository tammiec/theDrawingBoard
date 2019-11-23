
//          #####   ######   ######   #   #   #####
//         #       #         #      #   #   #   #
//          #####    #####      #      #   #   ####
//               #   #          #      #   #   #
//          #####  ######     #       ###    #
//
//
//
//
//
//
//



// load .env data into process.env
require('dotenv').config();
var fs = require('fs');

// server config
const PORT = process.env.PORT || 8080;
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const morgan = require('morgan');
const server = require('http').Server(app);
const io = require('socket.io')(server);
const cookieParser = require('cookie-session');

const { ActiveUsers } = require('./objects/activeUsers');
const { Authenticator } = require('./objects/authenticator');
const { ActiveMeeting } = require('./objects/activeMeetings');

activeUsers = new ActiveUsers();
authenticator = new Authenticator();
activeMeetings = new ActiveMeeting();

// db operations
const db = require('./db/queries/queries');

// db routes
const usersRoutes = require('./routes/usersRoutes');
const usersMeetingsRoutes = require('./routes/usersMeetingsRoutes');

// app.use('/', usersRoutes(db));

// Load the logger first so all (static) HTTP requests are logged to STDOUT
// 'dev' = Concise output colored by response status for development use.
// The :status token will be colored red for server error codes, yellow for client error codes, cyan for redirection codes, and uncolored for all other codes.
app.use(morgan('dev'));

app.use(cookieParser({ signed: false }));

app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send('testing purposes only');
});


server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

io.on('connection', (client) => {
  console.log('new client has connected');
  client.emit('msg', "there's a snake in my boot!");

  // handles logging in and activeUsers
  client.on('loginAttempt', (data) => {
    authenticator.authenticate(data.email, data.password)
      .then(res => {
        const authenticateAttempt = res;

        if (authenticateAttempt) {
          console.log('id to be added:');
          console.log(authenticateAttempt.id);
          activeUsers.addUser(authenticateAttempt.id, client)
          console.log('active users:');
          for (let user in activeUsers) {
            if (activeUsers[user].id) {
              console.log('user:', activeUsers[user].id);
            }
          }

          client.on('disconnect', () => {
            activeUsers.removeUser(authenticateAttempt.id);
          });
        } else {
          console.log('attempted login: failed');
        }
        client.emit('loginResponse', authenticateAttempt);
      });
  });

  //These lines are for testing purposes
  // client.join('theOneRoomToRuleThemAll');

  client.on('addClick', data => {
    console.log("message received");
    console.log(data.pixel.x);
    activeMeetings[data.meetingId].userPixels[data.user.id].push(data.pixel);
    console.log(activeMeetings[data.meetingId].userPixels[data.user.id]);
    io.to(data.meetingId).emit('drawClick', data);//pass message along
  })

  //End of test
  client.on('msg', (data) => {
    console.log(data);
  });

  client.on('fetchUser', (data) => {
    db.fetchUserByEmail(data.email)
      .then(res => {
        client.emit('user', res);
      });
  });

  client.on('fetchContactsByUserId', (data) => {
    db.fetchContactsByUserId(data.id, data.username)
      .then(res => {
        client.emit('contactsByUserId', res);
      });
  });

  client.on('fetchContactsGlobal', (data) => {
    db.fetchUsersByUsername(data.username)
      .then(res => {
        client.emit('contactsGlobal', res);
      });
  })

  client.on('fetchMeetings', (data) => {



    // TODO

    // fetch file from local storage
    // send the actual file, either through the socket event or a route




    db.fetchMeetingsByUserId(data.username, data.meetingStatus)
      .then(res => {

        // if going to send the file through the socket event, use the following logic

        // if res.link {
        // client.emit('meetingsWithDocs')
        // } else {

        client.emit('meetings', res);

        // }
      });
  });

  client.on('fetchMeeting', (data) => {
    db.fetchMeetingById(data.id)
      .then(res => {
        client.emit('meeting', res);
      });
  });

  client.on('addUser', (data) => {

    const credentials = {
      ...data
    };

    db.insertUser(credentials.username, credentials.email, credentials.password)
      .then(res => {
        client.emit('loginAttempt', credentials.username);
      });
  });

  client.on('insertMeeting', data => {



    db.insertMeeting(data.startTime, data.ownerId, data.name, data.description, data.status, data.file.name)
      .then(res => {
        client.emit('newMeeting', res[0]);
        // console.log(res[0].id);
        return res[0].id;
      })
      .then((id) => {
        fs.mkdir(`meeting_files/${id}`, () => { //makes a new directory for the meeting
          fs.writeFile(`meeting_files/${id}/${data.file.name}`, data.file.payload, (err) => {
            if (err) throw err;
            console.log('The file has been saved!');
          }); //Note promisy this I if we want to wait for the upload to finish before creating meeting
        });
        const promiseArray = [];

        for (let contact of data.selectedContacts) {
          console.log(contact.username);
          promiseArray.push(db.insertUsersMeeting(contact.id, id));
        }

        return Promise.all(promiseArray).then(() => {
          return id;
        });
      })
      .then((id) => {
        db.fetchMeetingWithUsersById(id)
          .then(res => {
            console.log(res[0].attendee_ids);
            for (let contactId of res[0].attendee_ids) {
              if (activeUsers[contactId]) {
                console.log(`${contactId} should now rerender`);
                activeUsers[contactId].socket.emit('itWorkedThereforeIPray', res[0]);
              }
            }
          });
      })
  });

  client.on('insertUsersMeeting', data => {
    db.insertUsersMeeting(data.userId, data.meetingId)
      .then(() => {
        client.emit('invitedUsers');
      });
  });

  client.on('startMeeting', (data) => {

    db.updateMeetingActiveState(data.id, true)
      .then(() => { // meeting status has been updated

        db.fetchMeetingById(data.id)
          .then(res => { // meeting has been retrieved
            const meeting = res[0];

            // set meeting pixel log
            meeting['userPixels'] = {};

            const attendeeIds = meeting.invited_users;

            // keep track of active meetings
            activeMeetings.addMeeting(meeting);
            // console.log(activeMeetings[meeting.id]);

            // send the meeting to all users who are logged in && invited to that meeting
            for (let id of attendeeIds) {
              if (activeUsers[id]) {
                const userClient = activeUsers[id].socket
                userClient.emit('meetingStarted', { meetingId: meeting.id, ownerId: meeting.owner_id });
              }
            }
          });
      });
  });

  client.on('enterMeeting', (data) => {
    if (!activeMeetings[data.meetingId].userPixels[data.user.id]) {
      activeMeetings[data.meetingId].userPixels[data.user.id] = [];
    }
    client.emit('enteredMeeting', activeMeetings[data.meetingId], activeMeetings[data.meetingId].userPixels);

    client.join(data.meetingId);
    io.to(data.meetingId).emit('newParticipant', (data.user));
  });

  // gotta handle the end meeting event
  client.on('endMeeting', (data) => {
    // todo: figure out document saving

    // data needs to be:
    // the document -> talk to T
    // end_time (not strictly needed)

    db.updateMeetingById(data.meetingId, data.endTime, false, 'past');
    io.to(data.meetingId).emit('requestNotes', data.meetingId);



    activeMeetings.removeMeeting(data.meetingId);

  });

  client.on('notes', (data) => {
    console.log('attempting to write notes');
    console.log(data.notes);
    db.updateUsersMeetingsNotes(data.user.id, data.meetingId, data.notes)
      .then(() => {
        client.emit('concludedMeetingId', data.meetingId);
      });
  });

  client.on('fetchNotes', (data) => {
    db.fetchUsersMeetingsByIds(data.user.id, data.meetingId)
      .then((res) => {
        client.emit('notes', res[0]);
      });
  });

});

