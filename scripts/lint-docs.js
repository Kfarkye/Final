// scripts/lint-docs.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOCS_DIR = path.join(__dirname, '../docs');

// Create the docs directory if it doesn't exist to prevent crash
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

let failed = false;

function lintFiles(dir) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      lintFiles(filePath);
    } else if (file.endsWith('.md')) {
      const content = fs.readFileSync(filePath, 'utf8');
      try {
        const { data } = matter(content);
        
        // Assertions
        if (!data.canonical_id || !data.canonical_id.startsWith('urn:truth:')) {
          console.error(`❌ Validation Failure in ${file}: Missing or invalid canonical URN ("canonical_id")`);
          failed = true;
        }
        if (!data.title) {
          console.error(`❌ Validation Failure in ${file}: "title" string is required.`);
          failed = true;
        }
        if (!data.domain) {
          console.error(`❌ Validation Failure in ${file}: "domain" string is required.`);
          failed = true;
        }
      } catch (err) {
        console.error(`❌ Parse Error in ${file}: Could not parse Frontmatter`, err);
        failed = true;
      }
    }
  });
}

console.log('Starting metadata linting checks...');
lintFiles(DOCS_DIR);

if (failed) {
  process.exit(1);
} else {
  console.log('🎉 Document validation completed successfully.');
}
