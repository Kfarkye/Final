import puppeteer from 'puppeteer-core';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
  // Use a common Mac Chrome executable path
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: "new"
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });
  
  const targetPath = `file://${path.resolve(__dirname, 'thedrip/player-page.html')}`;
  console.log(`Navigating to ${targetPath}`);
  
  await page.goto(targetPath, { waitUntil: 'networkidle0' });
  
  const outPath = '/Users/k.far.88/.gemini/antigravity-ide/brain/ab0f30af-e710-4d44-b328-6eb3d8dec799/player_page_preview.png';
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`Screenshot saved to ${outPath}`);
  
  await browser.close();
})();
