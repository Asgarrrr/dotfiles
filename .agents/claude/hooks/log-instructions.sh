#!/usr/bin/env bash
# InstructionsLoaded: journalise chaque fichier d'instructions entrant en contexte.
#
# Pourquoi
# --------
# Les regles scopees par frontmatter `paths` sont invisibles au demarrage : elles
# se chargent quand Claude lit un fichier correspondant. `/context` ne montre que
# l'etat a un instant donne. Ce journal donne la sequence complete, avec le motif
# de chargement, ce qui permet de mesurer le budget d'instructions reellement paye.
#
# Sortie : ~/.claude/logs/instructions.jsonl (une ligne JSON par chargement)
#
# La taille est mesuree sur le fichier lui-meme plutot que sur le champ `content`
# du payload. La doc annonce ce champ, mais le payload observe en 2.1.219 ne
# contient que : session_id, transcript_path, cwd, hook_event_name, file_path,
# load_reason. Lire le fichier evite en prime de recopier le contenu des regles
# a chaque tour.
#
# L'evenement ne supporte pas le controle de decision : le code de sortie est
# ignore et le fichier est deja charge quand le hook se declenche.

set -uo pipefail

log_dir="${HOME}/.claude/logs"
log="${log_dir}/instructions.jsonl"

mkdir -p "$log_dir" 2>/dev/null || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.file_path // ""' 2>/dev/null)

lines=0
bytes=0
if [ -n "$file" ] && [ -r "$file" ]; then
  lines=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
fi

printf '%s' "$input" | jq -c \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson lines "${lines:-0}" \
  --argjson bytes "${bytes:-0}" '{
  ts:      $ts,
  session: ((.session_id // "")[0:8]),
  reason:  (.load_reason // "unknown"),
  file:    (.file_path   // ""),
  cwd:     (.cwd         // ""),
  lines:   $lines,
  bytes:   $bytes
}' >> "$log" 2>/dev/null

exit 0
