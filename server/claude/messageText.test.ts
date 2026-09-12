import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanClaudePrompt, extractClaudePromptText } from './messageText.js';

test('extracts text blocks and rejects tool results', () => {
  assert.equal(extractClaudePromptText('plain prompt'), 'plain prompt');
  assert.equal(extractClaudePromptText([{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }]), 'first\nsecond');
  assert.equal(extractClaudePromptText([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), null);
  assert.equal(extractClaudePromptText([{ type: 'image' }]), null);
});

test('renders slash commands and drops local command output', () => {
  assert.equal(
    cleanClaudePrompt('<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>'),
    '/effort high'
  );
  assert.equal(cleanClaudePrompt('<local-command-stdout>Set effort level to high</local-command-stdout>'), null);
  assert.equal(cleanClaudePrompt('<local-command-caveat>Caveat: ...</local-command-caveat>'), null);
  assert.equal(cleanClaudePrompt('<bash-input>ls</bash-input>'), null);
  assert.equal(cleanClaudePrompt('This session is being continued from a previous conversation that ran out of context.'), null);
  assert.equal(cleanClaudePrompt('[Request interrupted by user for tool use]'), null);
});

test('strips injected context from real prompts', () => {
  assert.equal(
    cleanClaudePrompt('<system-reminder>\nremember things\n</system-reminder>\nFix the dashboard [Image #1] <ide_selection>foo</ide_selection>'),
    'Fix the dashboard'
  );
  assert.equal(cleanClaudePrompt('<system-reminder>only a reminder</system-reminder>'), null);
});
