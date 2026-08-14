import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../detect-language';

const SPANISH = 'Hola, ¿puedes enviarme el informe de la reunión que tuvimos por la mañana?';
const ENGLISH = 'Hey, can you send me the report of the meeting that we had in the morning?';

describe('detectLanguage', () => {
  it('picks the Latin-script language with the most function-word hits', () => {
    expect(detectLanguage(SPANISH, { candidates: ['es', 'en'] })).toBe('es');
    expect(detectLanguage(ENGLISH, { candidates: ['es', 'en'] })).toBe('en');
  });

  it('returns undefined when the detected language is not a candidate', () => {
    expect(detectLanguage(SPANISH, { candidates: ['en'] })).toBeUndefined();
  });

  it("returns the candidate's original spelling, not the primary subtag", () => {
    expect(detectLanguage(SPANISH, { candidates: ['es-419'] })).toBe('es-419');
  });

  it('detects a non-Latin script outright', () => {
    expect(
      detectLanguage('Привет, можешь прислать мне отчёт о встрече?', {
        candidates: ['ru', 'en'],
      }),
    ).toBe('ru');
  });

  it('reads kana as Japanese and bare Han as Chinese', () => {
    expect(
      detectLanguage('おはようございます、会議の資料を送ってください。', {
        candidates: ['ja', 'zh'],
      }),
    ).toBe('ja');
    expect(detectLanguage('请把会议资料发给我。', { candidates: ['ja', 'zh'] })).toBe('zh');
  });

  it('returns undefined for empty text or no candidates', () => {
    expect(detectLanguage('', { candidates: ['es', 'en'] })).toBeUndefined();
    expect(detectLanguage('   \n  ', { candidates: ['es', 'en'] })).toBeUndefined();
    expect(detectLanguage(SPANISH, { candidates: [] })).toBeUndefined();
  });

  it('returns undefined rather than guessing on text too short to be evidence', () => {
    expect(detectLanguage('ok', { candidates: ['es', 'en'] })).toBeUndefined();
    expect(detectLanguage('the', { candidates: ['es', 'en'] })).toBeUndefined();
  });
});
