/**
 * Shared jsdom harness for auto-mate content-script tests.
 *
 * Loads a MedHub HTML fixture into a jsdom window and injects the auto-mate
 * content modules (messages, dom-utils, recorder, engine, overlay) so they
 * attach to that window exactly as they would in a real page. Returns the
 * window plus the FAA_* namespaces for assertions.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');

const MODULE_FILES = [
  'common/messages.js',
  'common/dom-utils.js',
  'content/recorder.js',
  'content/engine.js',
  'content/overlay.js'
];

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function createPage(fixtureName) {
  const html = loadFixture(fixtureName);
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://ahc.medhub.com/u/r/procedures.mh'
  });
  const { window } = dom;

  // Inject each module as a <script> so it runs in the window realm.
  for (const file of MODULE_FILES) {
    const code = fs.readFileSync(path.join(EXT, file), 'utf8');
    const script = window.document.createElement('script');
    script.textContent = code;
    window.document.head.appendChild(script);
  }

  return {
    dom,
    window,
    document: window.document,
    MSG: window.FAA_MSG,
    DOM: window.FAA_DOM,
    RECORDER: window.FAA_RECORDER,
    ENGINE: window.FAA_ENGINE
  };
}

/** Dispatch a realistic value-change on an input within a jsdom window. */
function typeValue(window, el, value) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function clickEl(window, el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { createPage, loadFixture, typeValue, clickEl, sleep };
