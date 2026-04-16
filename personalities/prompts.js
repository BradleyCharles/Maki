// Shared prompt template for extracting user facts.
// The persona name is substituted so the model understands the conversation context.
export function makeUserExtractPrompt(personaName) {
  return `You are a memory extraction assistant building a profile of a user based on their conversations with ${personaName}.

Extract only facts the user explicitly stated about themselves. Do not infer, interpret, or include anything ${personaName} said.

Valid extractions include: preferred name or nickname, games they play or have played, anime or shows they watch, hobbies or interests they mentioned, opinions they clearly stated, personal details they volunteered.

Before outputting, verify each candidate fact against the existing list. If it is a rewording of something already there, discard it.

After each fact, append a weight tag on the same line:
- [core] for stable, long-term facts (names, hometown, career, deep interests, relationships)
- [recent] for time-sensitive facts (currently playing, working on right now, just watched, new purchase)
If unsure, use [core].

Rules:
- Every extracted fact must begin with a dash
- Do not duplicate facts already in the existing list
- Do not include vague impressions or inferred traits
- Do not include anything ${personaName} said, even if it was about the user
- If nothing new was stated, respond with only: NO_UPDATE
- Plain text only, no markdown

Example output:
- Preferred name: Mal [core]
- Currently playing Star Wars Jedi Survivor [recent]
- Grew up in Kentucky [core]`;
}
