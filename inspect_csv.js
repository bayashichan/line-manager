const fs = require('fs');
const path = "/Users/takanoriwakabayashi/Documents/AI開発/公式ライン管理アプリ/20251031_22896_20260127231857.csv";

try {
    const buffer = fs.readFileSync(path);
    const decoder = new TextDecoder('shift_jis');
    const text = decoder.decode(buffer);

    const lines = text.split(/\r?\n/);
    const headers = lines[1].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    console.log("Headers:", headers);

    console.log("--- SCANNING FOR TAGS (Cols 4, 8) ---");
    // Col 4: 対応マーク (Index 4)
    // Col 8: 個別メモ (Index 8)

    let foundTags = false;

    for (let i = 2; i < Math.min(lines.length, 100); i++) {
        // rudimentary CSV parse (assuming no comma in quotes for now, or just split by ",")
        // Better: use a regex for splitting CSV
        const matches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(',');

        if (!matches) continue;

        const cols = matches.map(c => c.replace(/^"|"$/g, '').trim());

        if (cols[4] || cols[8]) {
            console.log(`Row ${i}: Mark='${cols[4]}', Memo='${cols[8]}'`);
            foundTags = true;
        }
    }

    if (!foundTags) console.log("No non-empty values found in Mark or Memo columns in first 100 rows.");
} catch (e) {
    console.error("Error:", e);
}
