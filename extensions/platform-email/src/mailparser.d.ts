declare module 'mailparser' {
  export interface AddressObject {
    value: Array<{ address?: string; name?: string }>;
    text?: string;
  }
  export interface ParsedMail {
    from?: AddressObject;
    subject?: string;
    text?: string;
    html?: string | false;
    messageId?: string;
  }
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}
