import fs from 'fs';

const file = 'C:/Users/Sagar/.gemini/antigravity/scratch/job-notifier/frontend/src/App.tsx';
let content = fs.readFileSync(file, 'utf8');

const replacements = {
  'ℹ️': '<span className="material-symbols-outlined">info</span>',
  '⚡': '<span className="material-symbols-outlined">bolt</span>',
  '📋': '<span className="material-symbols-outlined">list_alt</span>',
  '⚙️': '<span className="material-symbols-outlined">settings</span>',
  '📜': '<span className="material-symbols-outlined">receipt_long</span>',
  '🔍': '<span className="material-symbols-outlined">search</span>',
  '🌐': '<span className="material-symbols-outlined">language</span>',
  '📅': '<span className="material-symbols-outlined">calendar_today</span>',
  '🔄': '<span className="material-symbols-outlined">sync</span>',
  '💼': '<span className="material-symbols-outlined">work</span>',
  '📥': '<span className="material-symbols-outlined">inbox</span>',
  '✅': '<span className="material-symbols-outlined">check_circle</span>',
  '📂': '<span className="material-symbols-outlined">folder_open</span>',
  '🏢': '<span className="material-symbols-outlined">business</span>',
  '📍': '<span className="material-symbols-outlined">location_on</span>',
  '💰': '<span className="material-symbols-outlined">payments</span>',
  '↗': '<span className="material-symbols-outlined" style={{ fontSize: "1rem", marginLeft: "4px" }}>open_in_new</span>',
  '↩️': '<span className="material-symbols-outlined">undo</span>',
  '🗑️': '<span className="material-symbols-outlined">delete</span>',
  '⚠️': '<span className="material-symbols-outlined">warning</span>',
  '🔴': '<span className="material-symbols-outlined" style={{ color: "var(--error)" }}>error</span>',
  '🟡': '<span className="material-symbols-outlined" style={{ color: "var(--warning)" }}>warning</span>',
  '🔵': '<span className="material-symbols-outlined" style={{ color: "var(--info)" }}>info</span>'
};

for (const [emoji, icon] of Object.entries(replacements)) {
  const regex = new RegExp(emoji, 'g');
  content = content.replace(regex, icon);
}

fs.writeFileSync(file, content, 'utf8');
console.log('Emojis replaced successfully.');
