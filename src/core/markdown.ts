export function appendToSection(
  content: string,
  section: string,
  entry: string,
  marker: string,
): string {
  if (content.includes(marker)) {
    return content;
  }

  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const heading = `## ${section}`;
  const index = normalized.indexOf(heading);
  const block = `\n${marker}\n${entry.trim()}\n`;

  if (index < 0) {
    return `${normalized}\n${heading}\n${block}`;
  }

  const afterHeading = normalized.indexOf("\n", index + heading.length);
  if (afterHeading < 0) {
    return `${normalized}${block}`;
  }

  const nextHeading = normalized.indexOf("\n## ", afterHeading + 1);
  if (nextHeading < 0) {
    return `${normalized}${block}`;
  }

  return `${normalized.slice(0, nextHeading)}${block}${normalized.slice(nextHeading)}`;
}
