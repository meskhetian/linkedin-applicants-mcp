// Friendly reminder only; we use the user's installed Google Chrome, so no browser download is needed.
if (!process.env.CI) {
  process.stderr.write(
    '\n[linkedin-applicants-mcp] Installed. Next: `npm run login` to open Chrome and sign in to LinkedIn once.\n' +
    '  (Uses your installed Google Chrome; no browser download needed.)\n\n'
  );
}
