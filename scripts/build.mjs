import {copyFile, mkdir} from "node:fs/promises";
await mkdir("dist/extension", {recursive: true});
for (const file of ["manifest.json", "popup.html", "popup.css", "people.html", "people.css"]) {
  await copyFile(`extension/${file}`, `dist/extension/${file}`);
}
