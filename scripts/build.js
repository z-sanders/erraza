'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICONS = Object.freeze([
  'arrow-up-right', 'arrow-right', 'credit-card', 'currency-btc', 'copy', 'x',
  'check', 'sun', 'moon', 'caret-down', 'info', 'arrow-clockwise', 'globe',
  'wallet', 'question', 'lock-simple', 'circle-notch',
]);

// License texts retrieved from the Google Fonts repository on 2026-11-05.
// Vendored here so production builds need neither network access nor credentials.
const OFL = `-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`;

function fontLicense(copyright, faq) {
  return `${copyright}\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\n${faq}\n\n\n${OFL}`;
}

const FONT_LICENSES = Object.freeze({
  'inter-OFL.txt': fontLicense('Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)', 'https://scripts.sil.org/OFL'),
  'space-grotesk-OFL.txt': fontLicense('Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)', 'http://scripts.sil.org/OFL'),
});
const FONT_SOURCES = `Font license sources (retrieved 2026-11-05):
Inter: https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt
Space Grotesk: https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/OFL.txt

Existing font files: inter-var.woff2 and space-grotesk-var.woff2.
Both font families use the SIL Open Font License 1.1. The license sources
above establish family licensing; the existing binary files were not
redownloaded or matched against an upstream release during this setup.
Retain the copyright notices and licenses when distributing these fonts.
`;

async function safeDirectory(directory) {
  const relative = path.relative(ROOT, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid asset directory.');
  let current = ROOT;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Asset directories must be real directories, not links.');
  }
}

async function writeAsset(filename, bytes) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generated asset targets must be regular files.');
    const existing = await fs.readFile(filename);
    if (existing.equals(Buffer.from(bytes))) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.writeFile(filename, bytes);
}

async function build() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24.x to build this project.');
  const iconDirectory = path.join(ROOT, 'public', 'icons');
  const fontsDirectory = path.join(ROOT, 'public', 'fonts');
  const licensesDirectory = path.join(fontsDirectory, 'licenses');
  await safeDirectory(iconDirectory);
  await safeDirectory(licensesDirectory);

  for (const font of ['inter-var.woff2', 'space-grotesk-var.woff2']) {
    const stat = await fs.lstat(path.join(fontsDirectory, font));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Missing regular font asset: ${font}`);
  }
  for (const icon of ICONS) {
    const source = require.resolve(`@phosphor-icons/core/assets/regular/${icon}.svg`);
    await writeAsset(path.join(iconDirectory, `${icon}.svg`), await fs.readFile(source));
  }
  const exampleIcon = require.resolve('@phosphor-icons/core/assets/regular/arrow-right.svg');
  const phosphorRoot = path.resolve(path.dirname(exampleIcon), '..', '..');
  await writeAsset(path.join(iconDirectory, 'LICENSE.txt'), await fs.readFile(path.join(phosphorRoot, 'LICENSE')));
  for (const [filename, text] of Object.entries(FONT_LICENSES)) await writeAsset(path.join(licensesDirectory, filename), text);
  await writeAsset(path.join(licensesDirectory, 'SOURCES.txt'), FONT_SOURCES);
  console.log(`Prepared ${ICONS.length} Phosphor icons and font/icon licenses. Existing public files were preserved.`);
}

module.exports = { build, ICONS, FONT_LICENSES };

if (require.main === module) {
  build().catch(error => {
    console.error('[build]', error.message);
    process.exitCode = 1;
  });
}
