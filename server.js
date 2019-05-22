// server.js

const express = require('express');
const app = express();
const fetch = require('node-fetch');
const path = require('path');

const dotenv = require('dotenv');
dotenv.config();

// Parse JSON bodies (as sent by API clients)
app.use(express.json());

app.get('/', function(req, res) {
    res.send('Healthy');
})
app.post('/pullrequest/', async function(req, res) {
    let body = req.body;
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
            parse: 'full',
            attachments: [
                {
                    fallback: '@prps - Review requested from ' + pull_request.user.login,
                    pretext: '@prps - Review requested from ' + pull_request.user.login,
                    color: '#' + label.color,
                    fields: [
                        {
                            title: pull_request.title,
                            value: pull_request.html_url,
                            short: false
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