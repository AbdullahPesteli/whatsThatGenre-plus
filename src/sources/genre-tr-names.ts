// Musicalyst/EveryNoise names, not Wikidata search aliases. Keep the
// distinctions between genres (e.g. Türk sanat müziği and Türk pop).
const names = new Map([
  ["anatolian rock", "Anadolu rock"],
  ["arabesk", "Arabesk"],
  ["fantezi", "Fantezi"],
  ["oyun havasi", "Oyun havası"],
  ["ozgun muzik", "Özgün müzik"],
  ["turk halk muzigi", "Türk halk müziği"],
  ["turk sanat muzigi", "Türk sanat müziği"],
  ["turkish art music", "Türk sanat müziği"],
  ["turkish folk", "Türk halk müziği"],
  ["turkish pop", "Türk pop"],
]);

// The caller supplies a folded name. Only apply the EveryNoise prefix rule
// to known names; leave other genres to the normal formatting fallback.
export function genreTrName(folded: string): string | undefined {
  const slug = folded.replace(/\s+/g, " ");
  if (!slug.startsWith("deep ")) return names.get(slug);
  const base = names.get(slug.slice(5));
  return base ? `${base} (derin)` : undefined;
}
