// GET / — the demo console: a chat page that talks to this same process.
//
// The markup itself lives in public/index.html so it stays a real HTML file
// (editable, diffable, no escaping-in-a-template-string traps). It is pure
// client code with relative endpoint paths — no CDN, no build step — which is
// what lets http://127.0.0.1:8787/ work offline on any host or port.
//
// The file is re-read when its mtime changes, so restyling it only needs a
// browser refresh instead of a server restart.
const fs = require('fs');
const path = require('path');
const express = require('express');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'index.html');
const MISSING = '<!DOCTYPE html><meta charset="utf-8"><title>qoder-proxy</title>'
    + '<p style="font:16px system-ui;padding:24px">演示页缺失：找不到 '
    + 'public/index.html（该文件未被仓库收录或被误删）。</p>';

let cached = null;

function pageHtml() {
    let stat;
    try {
        stat = fs.statSync(PAGE_FILE);
    } catch (e) {
        cached = null;
        return MISSING;
    }
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.html;
    let html;
    try {
        html = fs.readFileSync(PAGE_FILE, 'utf8');
    } catch (e) {
        // Keep serving the last good copy if the read fails mid-edit.
        return cached ? cached.html : MISSING;
    }
    cached = { mtimeMs: stat.mtimeMs, html };
    return html;
}

const router = express.Router();

router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(pageHtml());
});

module.exports = { router, pageHtml, PAGE_FILE };
