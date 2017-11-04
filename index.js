const fs = require('fs-extra');
const path = require('path');
const Chromy = require('chromy');
const extract = require('extract-zip');

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_INTERVAL = 500;

const PAGE = {
  IMPORT_CONFIG_BUTTON: '.file.unit',
  IMPORT_SELECTION_INPUT: '.file.unit input[type="file"]',
  OVERLAY_CONFIRM: '.overlay button.mrl',
  MENU_BUTTON: 'h1 button .icon-menu',
  MENU: '.menuList2.menuList3',
  ICON_INPUT: '.menuList2.menuList3 .file input[type="file"]',
  SELECT_ALL_BUTTON: 'button[ng-click="selectAllNone($index, true)"]',
  GENERATE_LINK: 'a[href="#/select/font"]',
  GLYPH_SET: '#glyphSet0',
  GLYPH_NAME: '.glyphName',
  DOWNLOAD_BUTTON: '.btn4',
};
const DEFAULT_OPTIONS = {
  outputDir: path.join(__dirname, 'output'),
};

const logger = (...args) => {
  console.log('[icomoon-cli]', ...args);
};

const waitVisible = (c, selector, timeout = DEFAULT_TIMEOUT) => new Promise((resolve, reject) => {
  let count = 0;
  let isVisible = false;
  const timer = setInterval(async () => {
    isVisible = await c.visible(selector);
    if (isVisible || count >= timeout) {
      clearInterval(timer);
      if (!isVisible) {
        reject(`${selector} is not visible after ${timeout}ms.`);
      }
      resolve(true);
    }
    count += DEFAULT_INTERVAL;
  }, DEFAULT_INTERVAL);
});

const getAbsolutePath = inputPath => {
  let absoluteSelectionPath = inputPath;
  if (!path.isAbsolute(inputPath)) {
    absoluteSelectionPath = path.resolve(process.env.PWD, inputPath);
  }
  return absoluteSelectionPath;
};

const checkDownload = dest => new Promise((resolve, reject) => {
  const interval = 1000;
  let downloadSize = 0;
  let timeCount = 0;
  const timer = setInterval(async () => {
    timeCount += interval;
    const stats = fs.statSync(dest);
    if (stats.size > 0 && stats.size === downloadSize) {
      clearInterval(timer);
      resolve();
    } else {
      downloadSize = stats.size;
    }
    if (timeCount > DEFAULT_TIMEOUT) {
      reject('Timeout when download file, please check your network.');
    }
  }, interval);
});

async function pipeline(options = {}) {
  try {
    const {
      icons,
      names = [],
      selectionPath,
      whenFinished,
    } = options;
    const outputDir = options.outputDir ? getAbsolutePath(options.outputDir) : DEFAULT_OPTIONS.outputDir;
    // prepare stage
    logger('Preparing...');
    if (!icons || !icons.length) {
      return logger('No new icons found.');
    }
    if (!selectionPath) {
      throw new Error('Please config a valid selection file path.');
    }
    let absoluteSelectionPath = getAbsolutePath(selectionPath);
    await fs.remove(outputDir);
    await fs.ensureDir(outputDir);
    // download stage
    const c = new Chromy({ visible: true });
    logger('Started a new chrome instance.');
    await c.goto('https://icomoon.io/app/#/select', {
      waitLoadEvent: false,
    });
    await c.send('Page.setDownloadBehavior', {
      behavior : 'allow',
      downloadPath: outputDir,
    });
    await waitVisible(c, PAGE.IMPORT_CONFIG_BUTTON);
    logger('Dashboard is visible, going to upload config file');
    await c.setFile(PAGE.IMPORT_SELECTION_INPUT, absoluteSelectionPath);
    await waitVisible(c, PAGE.OVERLAY_CONFIRM);
    await c.click(PAGE.OVERLAY_CONFIRM);
    logger('Uploaded config, going to upload new icon files');
    await c.click(PAGE.MENU_BUTTON);
    await c.setFile(PAGE.ICON_INPUT, icons.map(getAbsolutePath));
    await waitVisible(c, '#set0 .miBox:not(.mi-selected)');
    await c.click(PAGE.SELECT_ALL_BUTTON);
    logger('Uploaded and selected all new icons');
    await c.click(PAGE.GENERATE_LINK);
    await waitVisible(c, PAGE.GLYPH_SET);
    if (names.length) {
      logger('Changed names of icons');
      // update indexedDB
      const executeCode = `
        const request = indexedDB.open('IDBWrapper-storage', 1);
        request.onsuccess = function() {
          const db = request.result;
          const tx = db.transaction('storage', 'readwrite');
          const store = tx.objectStore('storage');
          const keys = store.getAllKeys();
          keys.onsuccess = function() {
            let timestamp;
            keys.result.forEach(function(key) {
              if (typeof key === 'number') {
                timestamp = key;
              }
            });
            const main = store.get(timestamp);
            main.onsuccess = function() {
              const data  = main.result;
              const names = JSON.parse('${JSON.stringify(names)}');
              for (let i = 0; i < names.length; i++) {
                data.obj.iconSets[0].selection[i].name = names[i];
              }
              store.put(data);
            }
          }
        }
      `;
      await c.evaluate(executeCode);
    }
    // reload the page let icomoon read latest indexedDB data
    await c.send('Page.reload');
    await c.waitLoadEvent();
    await waitVisible(c, PAGE.DOWNLOAD_BUTTON);
    await c.click(PAGE.DOWNLOAD_BUTTON);
    logger('Started to download icomoon.zip');
    const zipPath = path.join(outputDir, 'icomoon.zip');
    await checkDownload(zipPath);
    logger('Successfully downloaded, going to unzip it.');
    await c.close();
    // unzip stage
    extract(zipPath, { dir: outputDir }, async (err) => {
      if (err) {
        throw err;
      }
      await fs.remove(zipPath);
      logger(`Finished. The output directory is ${outputDir}.`);
      if (whenFinished) {
        whenFinished({ outputDir });
      }
    });
  } catch (error) {
    console.error(error);
    Chromy.cleanup();
  }
}

module.exports = pipeline;