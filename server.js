// server.js
const express = require('express');
const app = express();
const fetch = require('node-fetch');
const path = require('path');
const get = require('lodash/get');
const cloneDeep = require('lodash/cloneDeep');
const { Client } = require('pg');

// Set up environment variables
const dotenv = require('dotenv');
dotenv.config();

// Set up postgres client
const connectionString = process.env.DATABASE_URL;
const pgclient = new Client({
    connectionString,
    ssl: true,
});
pgclient.connect();

app.listen(process.env.PORT || 4000, function(){
    console.log('Your node js server is running');
});

// Parse JSON bodies
app.use(express.json());

// Parse url-encoded bodies
app.use(express.urlencoded({extended: true}));

/**
 * GET Routes
 */

app.get('/', function(req, res) {
    res.send('Healthy');
});

/**
 * POST Routes
 */
app.post('/action/', async function(req, res) {
    const payload = get(req, 'body.payload');

    if (!payload) {
        res.sendStatus(500);
        return;
    }

    const parsed = JSON.parse(payload);
    if (!parsed) {
        res.sendStatus(403);
        return;
    }

    const originalMessage = get(parsed, 'original_message');
    const action = get(parsed, 'actions[0].selected_options[0].value');

    if (action && originalMessage) {
        let newMessage = cloneDeep(originalMessage);

        if (action == 'approved') {
            newMessage = modifyMessage(originalMessage, ['approved', 'assign', 'changes'], '\n :done: - Approved by ' + parsed.user.name);
        }
        if (action == 'assign') {
            newMessage = modifyMessage(originalMessage, ['assign'], '\n Assigned to ' + parsed.user.name);
        }
        if (action == 'changes') {
            newMessage = modifyMessage(originalMessage, ['approved', 'assign', 'changes'], '\n :exclamation: - Changes requested by ' + parsed.user.name);
        }

        res.send(newMessage);
    } else {
        res.sendStatus(403);
    }
});

app.post('/pullrequest/', async function(req, res) {
    const body = get(req, 'body');
    const action = get(body, 'action');

    const branch = get(body, 'pull_request.head.ref');
    const pull_request = get(body, 'pull_request');

    if (process.env.DEBUG === 'true' && branch) {
        console.log('branch ', branch);
    }

    if (action !== 'labeled') {
        // res.send('Action is not labeled or there is no body');
        // return;
    }

    if (action == 'labeled') {
        processLabeled(body, res);
    }

    if (action == 'review_requested') {
        const reviewers = get(body, 'pull_request.requested_reviewers').map(function (reviewer) {
            return reviewer && reviewer.login
        });
        
        const message = {
            "parse": "full",
            "text": pull_request.user.login + ' is requesting a review from:' + '\n' +
                '    ' + reviewers.join(',') + '\n' +
                'On branch: `' + branch + '`',
            "response_type": "in_channel",
            "attachments": [
                {
                    "fallback": pull_request.html_url,
                    "title": pull_request.title,
                    "text": pull_request.html_url,
                    "color": '#' + '2BABE2',
                    "attachment_type": "default"
                }
            ]
        };
        
        const params = {
            text: message.text,
            attachments: JSON.stringify(message.attachments),
            parse: message.parse,
            response_type: message.response_type,
            token: process.env.BOT_TOKEN,
            channel: process.env.CHANNEL
        };

        const query =  Object.keys(params)
            .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
            .join('&');

        const slack_message = await fetch('https://slack.com/api/chat.postMessage?' + query, {
            method: 'POST'
        }).then((res) => res.json())
        const timestamp = get(slack_message, 'ts');
        
        savePullsMessages(branch, timestamp);

        res.send({ branch, timestamp });
        return;
    }
});

/**
 * Methods
 */
function modifyMessage (newMessage, optsToRemove = [], appendage) {
    let attachment = get(newMessage, 'attachments[0]');
    attachment.text = attachment.text + appendage;

    newMessage.attachments = [];

    // Remove used option
    let options = get(attachment, 'actions[0].options');
    options = options.reduce((accumulator, option) => {
        if (!optsToRemove.includes(option.value)) {
            accumulator.push(option);
        }
        return accumulator;
    }, []);
    attachment.actions[0].options = options;

    newMessage.attachments.push(
        attachment
    );

    return newMessage;
}

function savePullsMessages (timestamp, branch) {
    const text = 'INSERT INTO pulls_messages(message_ts, branch) VALUES($1, $2) RETURNING *';
    const values = [timestamp, branch];
    
    return pgclient.query(text, values)
        .then(res => {
            console.log(res.rows[0])
        })
        .catch(e => console.error(e.stack));
}

async function processLabeled (body, res) {
    const pull_request = get(body, 'pull_request');
    const label = get(body, 'label');
    const labelName = get(label, 'name');

    // Parse repo out from URL
    const repo = get(new RegExp("[^\/]+(?=\/pull\/)").exec(pull_request.html_url), '[0]');

    // Set slack notification tag based on repo
    const pr_notify_tag = (function(repo) {
        switch(repo) {
            case 'chef':
                return '@devops';
            default:
                return '@prps';
        }
    })(repo);

    if (!label || !label.name) {
        res.send('No label');
        return;
    }

    if (labelName.includes('Review: Ready')) {
        const message = {
            "parse": "full",
            "text": pr_notify_tag + ' - Review requested from ' + pull_request.user.login,
            "response_type": "in_channel",
            "attachments": [
                {
                    "fallback": pull_request.html_url,
                    "title": pull_request.title,
                    "text": pull_request.html_url,
                    "color": '#' + label.color,
                    "attachment_type": "default",
                    "callback_id": "action",
                    "actions": [
                        {
                            "name": "actions",
                            "text": "Choose a slack action",
                            "type": "select",
                            "options": [
                                {
                                    "text": "Assign To Me",
                                    "value": "assign"
                                },
                                {
                                    "text": "Requested Changes",
                                    "value": "changes"
                                },
                                {
                                    "text": "Approved",
                                    "value": "approved"
                                }
                            ]
                        }
                    ]
                }
            ]
        };

        res.sendStatus(200);

        const slack_message = await fetch(process.env.SLACK_TEST_WEBHOOK, {
            method: 'POST',
            body: JSON.stringify(message),
            headers: { 'Content-Type': 'application/json' }
        });

        console.log(slack_message);
    } else {
        res.send('"' + label.name + '" is not supported');
        return;
    }
}
