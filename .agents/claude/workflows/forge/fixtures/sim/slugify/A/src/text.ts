export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function slugify(title: string): string {
  throw new Error('not implemented')
}
