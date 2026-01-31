const fs = require('fs');
const path = "/Users/takanoriwakabayashi/Downloads/別アプリへのインポート用_25594_20260127232634.csv";

try {
    const buffer = fs.readFileSync(path);
    const decoder = new TextDecoder('shift_jis');
    const text = decoder.decode(buffer);

    const lines = text.split(/\r?\n/).slice(0, 10);

    console.log("--- FIRST 5 LINES ---");
    lines.forEach((l, i) => {
        console.log(`[Row ${i}] ${l}`);
    });

} catch (e) {
    console.error("Error:", e);
}
