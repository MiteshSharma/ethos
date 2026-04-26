import { createContext, useContext } from 'react';

export interface SkinConfig {
  name: string;
  bannerColor: string;
  modelColor: string;
  userColor: string;
  assistantColor: string;
  promptGlyph: string;
  promptColor: string;
  borderStyle: 'single' | 'double' | 'round' | 'bold' | 'classic' | 'singleDouble';
  thinkingColor: string;
  toolPrefix: string;
}

export const SKINS: Record<string, SkinConfig> = {
  default: {
    name: 'default',
    bannerColor: 'white',
    modelColor: 'gray',
    userColor: 'cyan',
    assistantColor: 'green',
    promptGlyph: '›',
    promptColor: 'cyan',
    borderStyle: 'single',
    thinkingColor: 'magenta',
    toolPrefix: '⚙',
  },
  dark: {
    name: 'dark',
    bannerColor: 'blueBright',
    modelColor: 'gray',
    userColor: 'blueBright',
    assistantColor: 'greenBright',
    promptGlyph: '▶',
    promptColor: 'blueBright',
    borderStyle: 'round',
    thinkingColor: 'magentaBright',
    toolPrefix: '⚡',
  },
  minimal: {
    name: 'minimal',
    bannerColor: 'white',
    modelColor: 'gray',
    userColor: 'white',
    assistantColor: 'white',
    promptGlyph: '>',
    promptColor: 'white',
    borderStyle: 'classic',
    thinkingColor: 'gray',
    toolPrefix: '*',
  },
};

export const DEFAULT_SKIN = SKINS.default;

export const SkinContext = createContext<SkinConfig>(DEFAULT_SKIN);

export function useSkin(): SkinConfig {
  return useContext(SkinContext);
}
