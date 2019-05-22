// server.js

const express = require('express');
const app = express();
const fetch = require('node-fetch');
const path = require('path');
const get = require('lodash/get');
const cloneDeep = require('lodash/cloneDeep');

const dotenv = require('dotenv');
dotenv.config();

// Parse JSON bodies
app.use(express.json());

// Parse url-encoded bodies
app.use(express.urlencoded({extended: true}));

app.get('/', function(req, res) {
    res.send('Healthy');
});


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
app.post('/action/', async function(req, res) {
    const payload = req.body.payload;

    let parsed;
    if (payload) {
        parsed = JSON.parse(payload);
    }
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
    const body = req.body;
    if (body && body.action !== 'labeled') {
        res.send('Action != labeled, or no body');
        return;
    }

    const pull_request = body && body.pull_request
    const label = pull_request && body.label;
        
    if (!label || !label.name) {
        res.send('No label');
        return;
    }
    
    if (label.name.includes('Review: Ready')) {
        const message = {
            "parse": "full",
            "text": '@prps - Review requested from ' + pull_request.user.login,
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

        await fetch(process.env.SLACK_WEBHOOK, {
            method: 'POST',
            body: JSON.stringify(message),
            headers: { 'Content-Type': 'application/json' }
        });
    } else {
        res.send(label.name);
        return;
    }
});

app.listen(process.env.PORT || 4000, function(){
    console.log('Your node js server is running');
});