import type { RecipeDiscoverChatsOutput } from '@ethosagent/web-contracts';
import { useMutation } from '@tanstack/react-query';
import { Button, Input, Radio } from 'antd';
import { useState } from 'react';
import type { ChannelSetupDraft } from '../../lib/recipes';
import { rpc } from '../../rpc';

// Setting up the delivery bot ON THIS PAGE, because there is nowhere else it
// can be done (plan/phases/recipes-gallery.md D14).
//
// A Telegram bot binds to a PERSONALITY, and the recipe's personality does not
// exist until the recipe installs. So the old "bind a bot to this agent in
// Communications, then re-check" was a requirement that could never be met —
// the user was sent to a page whose form needed the thing they were trying to
// create. Two steps replace it:
//
//   1. Paste the @BotFather token. The server probes it live and answers with
//      the resolved @botname, which is the confirmation that the right thing
//      was pasted — and the only part of the credential that ever comes back.
//   2. Message the bot, then press "Check for your message". The SERVER reads
//      one `getUpdates` and returns the chats it finds. The user picks one.
//      R0's invariant is intact: there is no free-text chat id field here.
//
// The button says exactly what it does. It is not a spinner that waits for
// something to happen — it is one read, on demand.

export function RecipeChannelSetup({
  platform,
  value,
  onChange,
  onGatewayOwnsToken,
}: {
  platform: 'telegram';
  value: ChannelSetupDraft | null;
  onChange: (draft: ChannelSetupDraft | null) => void;
  /** The gateway is already polling this token — fall back to the target picker. */
  onGatewayOwnsToken: () => void;
}) {
  const [token, setToken] = useState('');
  const [result, setResult] = useState<RecipeDiscoverChatsOutput | null>(null);

  const discover = useMutation({
    mutationFn: () => rpc.recipes.discoverChats({ platform, token: token.trim() }),
    onSuccess: (next) => {
      setResult(next);
      // A previously-picked chat belongs to a previous answer. Clear it rather
      // than carry it forward against a token that may now be different.
      onChange(null);
      if (next.status === 'gateway_owns_token') onGatewayOwnsToken();
    },
  });

  const pick = (chatId: string) => {
    const chat = result?.chats.find((c) => c.chatId === chatId);
    if (!chat) return;
    onChange({
      platform,
      token: token.trim(),
      chatId: chat.chatId,
      botLabel: result?.botLabel ?? null,
      chatLabel: chat.label,
    });
  };

  return (
    <div className="recipe-setup">
      <div className="recipe-setup-step">
        <label className="recipe-field-label" htmlFor="recipe-bot-token">
          1 — Paste the token @BotFather gave you
        </label>
        <span className="recipe-rowlist-sub">
          Open Telegram, message @BotFather, send <span className="recipe-mono">/newbot</span>, and
          paste the token it replies with. It is stored the same way Communications stores one, and
          is never shown again.
        </span>
        <Input.Password
          id="recipe-bot-token"
          value={token}
          placeholder="123456789:AA..."
          autoComplete="off"
          onChange={(e) => {
            setToken(e.target.value);
            setResult(null);
            onChange(null);
          }}
        />
      </div>

      <div className="recipe-setup-step">
        <div className="recipe-field-label">2 — Send your new bot a message, then check for it</div>
        <span className="recipe-rowlist-sub">
          A bot cannot start a conversation on Telegram, so it has to hear from you first. One read
          — no waiting, no polling.
        </span>
        <div className="recipe-setup-row">
          <Button
            onClick={() => discover.mutate()}
            loading={discover.isPending}
            disabled={token.trim().length === 0}
          >
            Check for your message
          </Button>
          {result?.botLabel ? (
            <span className="recipe-setup-bot recipe-mono">{result.botLabel}</span>
          ) : null}
        </div>
      </div>

      <SetupOutcome result={result} error={discover.error} />

      {result?.status === 'ok' && result.chats.length > 0 ? (
        <Radio.Group
          className="recipe-target-group"
          value={value?.chatId}
          onChange={(e) => pick(String(e.target.value))}
        >
          {result.chats.map((chat) => (
            <Radio key={chat.chatId} value={chat.chatId}>
              <span className="recipe-mono">{chat.label}</span>
              <span className="recipe-row-action">
                {chat.kind} · chat {chat.chatId} — this chat has messaged your bot
              </span>
            </Radio>
          ))}
        </Radio.Group>
      ) : null}
    </div>
  );
}

/**
 * Every non-`ok` answer, said plainly. `gateway_owns_token` is the one that
 * looks like a failure and is not: Telegram answers a second concurrent
 * `getUpdates` on one token with 409, which means the running gateway already
 * has this bot — and its own record of who has messaged it is what the delivery
 * picker above reads.
 */
function SetupOutcome({
  result,
  error,
}: {
  result: RecipeDiscoverChatsOutput | null;
  error: unknown;
}) {
  if (error) {
    return (
      <div className="recipe-setup-note recipe-setup-note--bad">
        {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  if (!result) return null;

  if (result.status === 'gateway_owns_token') {
    return (
      <div className="recipe-setup-note">
        This bot is already running in your gateway, so its own chat list is the one to use — pick a
        chat from <span className="recipe-mono">Deliver to</span> above.
      </div>
    );
  }
  if (result.status === 'waiting') {
    return (
      <div className="recipe-setup-note">
        Token accepted. Nothing has messaged {result.botLabel ?? 'this bot'} yet — open Telegram,
        send it anything, then check again.
      </div>
    );
  }
  if (result.status === 'rejected') {
    return (
      <div className="recipe-setup-note recipe-setup-note--bad">
        Telegram refused that token. Check it with @BotFather and paste it again.
      </div>
    );
  }
  if (result.status === 'unreachable') {
    return (
      <div className="recipe-setup-note recipe-setup-note--bad">
        Could not reach Telegram — nothing was changed. {result.error ?? ''} Try again in a moment.
      </div>
    );
  }
  return null;
}
