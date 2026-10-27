const normalized=value=>String(value).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('es');

/** A clarification fixture must specify the missing data, not just its kind. */
export function clarificationErrors(expected,result) {
  if(typeof result.question!=='string'||!result.question.trim()) return ['La aclaración debe contener una pregunta.'];
  if(!Array.isArray(expected.questionMustMention)||!expected.questionMustMention.length)
    return ['Falta definir qué datos debe preguntar esta aclaración.'];
  const question=normalized(result.question),errors=[];
  for(const group of expected.questionMustMention) {
    const alternatives=Array.isArray(group)?group:[group];
    if(!alternatives.length||alternatives.some(term=>typeof term!=='string'||!term.trim())||!alternatives.some(term=>question.includes(normalized(term))))
      errors.push(`La pregunta debe mencionar ${alternatives.join(' / ')}.`);
  }
  for(const term of expected.questionMustNotMention??[])
    if(question.includes(normalized(term))) errors.push(`La pregunta vuelve a pedir un dato resuelto o ajeno: ${term}.`);
  return errors;
}
