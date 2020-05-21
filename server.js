// server.js
const express = require('express');
const app = express();
const fetch = require('node-fetch');
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

    if (process.env.DEBUG === 'true' && branch) {
        console.log('branch ', branch);
    }

    if (action == 'closed') {
        const merged = get(body, 'pull_request.merged');
        const base = get(body, 'pull_request.base.ref');
        if (base != 'master') {
            res.sendStatus(200);
            return; 
        }
        if (merged == true || merged == "true") {
            postClosed(body, res);
            return;
        }
    }

    if (action == 'labeled') {
        processLabeled(body, res);
        return;
    }

    const actionToUpdate = [
        'review_requested',
        'review_request_removed',
        'unassigned',
        'assigned',
        'unlabeled'
    ]

    if (actionToUpdate.indexOf(action) >= 0) {
        updateOrPostMessage(body, res);
        res.send(200);
        return;
    }

    res.send('Action is not labeled, or closed, or there is no body');
});

function postClosed (body, res) {
    const body = get(res, 'body');
    
    const method = 'postMessage';

    const merged_by = get(body, 'pull_request.merged_by.login');
    const merged_by_avatar = get(body, 'pull_request.merged_by.avatar_url');
    const repo = get(body, 'repository.name');
    

    const message = {
        "parse": "full",
        "text": `${merged_by} is deploying ${repo}`,
        "response_type": "in_channel"
    };
    
    const params = {
        parse: message.parse,
        response_type: message.response_type,
        token: process.env.SLACK_TOKEN,
        channel: process.env.CLOSED_CHANNEL,
        icon_url: merged_by_avatar
    };
    
    params.text = message.text;

    const query =  Object.keys(params)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&');

    const slack_message = await postMessage(method, query);
    res.sendStatus(200);
}

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

function savePullsMessages (branch, timestamp) {
    const text = 'INSERT INTO pulls_messages(message_ts, branch) VALUES($1, $2) RETURNING *';
    const values = [timestamp, branch];
    
    return pgclient.query(text, values)
        .then(res => {
            console.log(res.rows[0])
            return res.rows[0]
        })
        .catch(e => console.error(e.stack));
}

function getPullsMessages (branch) {    
    const text = 'SELECT * from pulls_messages WHERE branch = $1 ORDER BY id DESC LIMIT 1';
    const values = [branch];
    
    return pgclient.query(text, values)
        .then(res => {
            console.log(res.rows[0])
            return res.rows[0]
        })
        .catch(e => console.error(e.stack));
}

function postMessage (method, query) {
    const url = 'https://slack.com/api/chat.' + method + '?' + query;

    return fetch(url, {
        method: 'POST'
    }).then((res) => res.json())
}

function getPreviousMessages (limit, timestamp) {
    const params = {
        limit: limit,
        token: process.env.SLACK_TOKEN,
        channel: process.env.CHANNEL,
        inclusive: true
    };

    if (timestamp) {
        params.latest = timestamp;
    }

    const query =  Object.keys(params)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&');

    const url = 'https://slack.com/api/conversations.history?' + query;

    return fetch(url, {
        method: 'GET'
    }).then((res) => res.json())

}

async function processLabeled (body, res) {
    await updateOrPostMessage(body, res);

    const pull_request = get(body, 'pull_request');
    const repo = get(body, 'repository.name');
    const owner = get(body, 'repository.owner.login');
    const branch = get(body, 'pull_request.head.ref');
    const label = get(body, 'label');
    const labelName = get(label, 'name');
    const sender = get(body, 'sender.login');
    const senderImage = get(body, 'sender.avatar_url');

    if (!label || !labelName) {
        res.send('No label');
        return;
    }

    if (labelName.indexOf('Skip PRP Channel') > -1) {
        res.send('Skip PRP Channel');
        return;
    }

    const pullsMessage = await getPullsMessages(branch);
    const useChatUpdate = pullsMessage && pullsMessage.message_ts ? true : false

    const params = {
        parse: "full",
        response_type: "in_channel",
        token: process.env.SLACK_TOKEN,
        channel: process.env.CHANNEL
    };

    if (!useChatUpdate) {
        res.sendStatus(403);
    }

    params.thread_ts = pullsMessage && pullsMessage.message_ts;
    params.text = 'Label added to *' + repo + '*: \n    ' + labelName;

    if (labelName.includes('Review: Ready')) {        
        params.text = 'https://github.com/pulls?utf8=%E2%9C%93&q=is%3Apr%3A' 
            + owner + '+is%3Aopen+head%3A' 
            + branch + '\n\n' + params.text
    }

    params.username = sender;
    params.icon_url = senderImage;

    const threadQuery =  Object.keys(params)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&');

    const threadMessage = await postMessage('postMessage', threadQuery)

    res.sendStatus(200);
}

async function updateOrPostMessage (body, res) {
    const pull_request = get(body, 'pull_request');
    const branch = get(body, 'pull_request.head.ref');
    const reviewers = get(body, 'pull_request.requested_reviewers').map(function (reviewer) {
        return reviewer && reviewer.login
    }).join(', ');
    const assignees = get(body, 'pull_request.assignees').map(function (assignee) {
        return assignee && assignee.login
    }).join(', ');
    const repo = get(body, 'repository.name');
    const mergeable = get(body, 'pull_request.mergeable');
    const pull_requestImage = get(body, 'pull_request.user.avatar_url');
    const action = get(body, 'action');

    const pr_notify_tag = (function(repo) {
        switch(repo) {
            case 'chef':
                return '@devops';
            case 'salt':
                return '@devops';
            default:
                return '@prps';
        }
    })(repo);

    const labels = get(body, 'pull_request.labels');
    const hasReviewReadyLabel = !!labels.find(label => String(label.name).includes('Review: Ready'));
    const hasSkipReviewLabel = !!labels.find(label => String(label.name).includes('Skip PRP Channel'));
    const attachments = labels.map(function (label) {
        return {
            title: String(label.name)
                .replace(/0 - In Development/, ":git-warning:  In Development")
                .replace(/1 - Review: Ready/, ":git-review:  Ready for Review")
                .replace(/2 - Review: In Progress/, ":git-looking:  Review in Progress")
                .replace(/3 - Review: Done/, ":git-approved:  Approved"),
            color: label.color
        }
    });

    const pullsMessage = await getPullsMessages(branch);
    const timestamp = pullsMessage && pullsMessage.message_ts;
    const matchingMessageResponse = await getPreviousMessages(1, timestamp);

    const messageExists = matchingMessageResponse.messages ? (
            matchingMessageResponse.messages
                .filter(message => message.ts === timestamp && message.subtype != 'tombstone')
                .length > 0
        ) : false;

    // Unlabeled should not create a new message when has ready review label exists...
    if (!messageExists && hasReviewReadyLabel && action !== 'labeled') {
        return 'No message posted, '
    }

    if (!messageExists && !hasReviewReadyLabel || hasSkipReviewLabel) {
        return 'No message posted';
    }

    const method = messageExists ? 'update' : 'postMessage';
    
    let assigneesSection = assignees ? '> Assigned to: ' + assignees + '\n' : ''
    let requestedReviewersSection = reviewers ? 
        ' - ' + pull_request.user.login + ' is requesting a review from:' + 
            '\n' + '    ' + reviewers + '\n' 
        : '\n'
    const message = {
        "parse": "full",
        "text": pr_notify_tag  + requestedReviewersSection +
            assigneesSection + 
            'On branch: `' + branch + '`' + '\n' +
            '\n' +
            '> *' + pull_request.title + '*' + '\n' + 
            '> ' + pull_request.html_url,
        "response_type": "in_channel",
        "attachments": attachments
    };
    
    const params = {
        parse: message.parse,
        response_type: message.response_type,
        token: process.env.SLACK_TOKEN,
        channel: process.env.CHANNEL,
        icon_url: pull_requestImage
    };

    if (messageExists) {
        params.ts = timestamp;
    }
    
    params.text = message.text;
    params.attachments = JSON.stringify(message.attachments);

    const query =  Object.keys(params)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&');

    const slack_message = await postMessage(method, query);
    const new_timestamp = get(slack_message, 'ts');
    
    if (!messageExists) {
        savePullsMessages(branch, new_timestamp);
    }

    return slack_message;
}