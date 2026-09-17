// Shared helper for the :9222 drive. Connects to Donny's persistent Chrome,
// opens OUR OWN tab, brings it to front, and NEVER closes the browser.
// chrome-mutex arg order is (lockId, {port}) on release — the reverse silently no-ops.
const puppeteer = require('C:/Users/donny/Documents/flywheel-cmd/node_modules/puppeteer-core');
const mutex = require('C:/Users/donny/Documents/passive-empire/shared/chrome-mutex.js');

async function connect() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
    protocolTimeout: 600000,
  });
  return browser;
}

async function ownTab(browser, url) {
  const page = await browser.newPage();
  await page.bringToFront();               // background tabs silently eat clicks
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

module.exports = { connect, ownTab, mutex, puppeteer };
