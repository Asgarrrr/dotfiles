export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
