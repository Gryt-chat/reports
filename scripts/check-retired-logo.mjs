// Fails when a committed file is a copy of the retired 2023 owl mark, the dark owl
// on a violet disc. The current logo is Gryt-chat/client public/logo.svg.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// md5 of every copy found across Gryt-chat, archived repos included (GRYT-1173).
const RETIRED = new Set([
  "011a7dc4f874350be407793243132d0e", // gryt-app/public/images/gryt.png
  "0547c40c2fcf4a924d1fbaa62b5942a7", // gryt-assets/Logo/Rounded/owl-4.png
  "0f6c59d6834da2e54f19eb5e7a2b2a84", // gryt-app/public/favicon.ico
  "1d64f34ed0f219e1d886f4136bdd434c", // gryt-assets/Logo/Square/owl-4.png
  "1ea1fd71e7e13b61c9c848b479064f7b", // gryt-assets/Logo/Transparent/light.png
  "299892a8c38021f00c571da7baae7d2f", // gryt-assets/Wallpapers/purple_logo_dark.png
  "2f5d2c632dfe163ed638adf1f769a0ef", // gryt-app/public/favicon-16x16.png
  "2facf95b9d5bb9354ecfaa7783289064", // gryt-assets/Wallpapers/pink_logo.png
  "320c71f6ba72195473cd9a409047b042", // .github-private/profile/owl-9.png
  "32642a4290ac5de9ef2d966fe1fa233e", // gryt-assets/Logo/Rounded/owl-7.png
  "3438406b2989b2dd53be960016f55ac8", // reports/assets/gryt-mark.png
  "358e982ae060fe55a2c169cfab0b058b", // gryt-assets/Logo/Square/owl-6.png
  "38d63a8486b8fec96a76ea1a1b24b3ae", // gryt-assets/Logo/Square/owl-5.png
  "479d86fc1402a88f34a7027f3e12e435", // gryt-app/public/favicon-32x32.png
  "4fa97d5e118ba3c98ab38ba41c337038", // gryt-assets/Logo/Rounded/owl-8.png
  "5994198457bf254636f1c2f4b7cbdd61", // gryt-auth/public/EmailLogo.png
  "5d026c62e9ffb2aa537668e8f1dd66ae", // gryt-assets/Logo/Rounded/owl-5.png
  "70a334ffc7dc78d4714f4d733f8f1643", // gryt-assets/Logo/Square/owl-2.png
  "765f4d0c21635661c6c35f05b13dbed2", // gryt-assets/Logo/Rounded/owl-3.png
  "79cb09d71743d8858acc9371715114c5", // gryt-app/public/android-chrome-512x512.png
  "7d985b786034f56db02542a913ba9e3b", // gryt-assets/Logo/Rounded/owl-6.png
  "9253f2704b9dcc346b4307f7504456af", // gryt-assets/Logo/Square/owl-8.png
  "9cdceda42969b6b11195ab61079b1b3f", // gryt-app/public/apple-touch-icon.png
  "9e0c6bc6845c1d3b3a53a2f0a679939a", // gryt-app/public/android-chrome-192x192.png
  "aedce3fe34bb5796722d96aa695a0c73", // auth/themes/gryt/admin/resources/img/logo.svg
  "b151ff0d560bc32396a5275e4c2d7e31", // gryt-assets/Logo/Square/owl-9.png
  "cceefc660e8f47c0f8f0d5f8316d12b8", // gryt-assets/Logo/Square/owl-3.png
  "d5f68dd3e96a92a87a5e76f56d38d7a7", // gryt-assets/Wallpapers/icons_logo.png
  "db2ab2a01c59cc5d0314a9148f687f66", // gryt-client/renderer/public/images/round-owl-v2.png
  "e1df8769dd4dc196908bcfd03ba3ee74", // gryt-assets/Logo/Transparent/dark.png
  "eef9c575f41365e1635000598b236303", // ui/apps/docs/public/owl.png
  "f42857cdb47d8bad6cedce170955be02", // gryt-assets/Logo/Rounded/owl-9.png
  "f8f8e59424b98c3b733afe9aead7220f" // gryt-assets/Logo/Square/owl-7.png
]);

const committed = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const copies = committed.filter((file) => {
  try {
    return RETIRED.has(createHash("md5").update(readFileSync(file)).digest("hex"));
  } catch {
    return false;
  }
});

if (copies.length > 0) {
  console.error("check-retired-logo: the old owl mark is committed. Use the current logo instead:");
  for (const file of copies) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`check-retired-logo: ${committed.length} files, no copy of the old mark`);
