'use strict';
const { app, BrowserWindow } = require('electron');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try { ready = await js('window.__neo && window.__neo.ready === true'); } catch { ready = false; }
    if (ready) break;
  }
  console.log('[domcheck] ready', ready);
  const report = await js(`(() => {
    const out = {};
    out.map = Boolean(document.querySelector('#map'));
    out.mapStage = Boolean(document.querySelector('#mapStage'));
    out.mapChildren = document.querySelector('#mapStage')?.children.length;
    out.mapHtml = (document.querySelector('#mapStage')?.innerHTML || '').length;
    out.panelTabs = document.querySelector('.panel-tabs')?.outerHTML?.slice(0, 600);
    out.panel = Boolean(document.querySelector('.map-panel'));
    out.panelStyle = (() => { const el = document.querySelector('.map-panel'); return el ? getComputedStyle(el).display : 'missing'; })();
    out.toolbar = Boolean(document.querySelector('.map-float-toolbar'));
    out.stageSize = (() => { const el = document.querySelector('#mapStage'); return el ? [el.clientWidth, el.clientHeight] : null; })();
    out.mapSize = (() => { const el = document.querySelector('#map'); return el ? [el.clientWidth, el.clientHeight] : null; })();
    out.leafletPanes = (() => { const el = document.querySelector('#map'); return el ? el.querySelectorAll('.leaflet-pane').length : -1; })();
    out.tileImgs = document.querySelectorAll('#map img.leaflet-tile').length;
    out.canvas = Boolean(document.querySelector('#map canvas.map-data-canvas'));
    out.streetsDock = Boolean(document.querySelector('#streetsDock'));
    out.kmlDock = Boolean(document.querySelector('#kmlDock'));
    out.dxfDock = Boolean(document.querySelector('#dxfDock'));
    out.errors = [];
    return JSON.stringify(out);
  })()`);
  console.log('[domcheck]', report);
  const errs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errs.push(message);
  });
  await wait(3000);
  win.destroy();
  process.exit(0);
}

module.exports = run;
