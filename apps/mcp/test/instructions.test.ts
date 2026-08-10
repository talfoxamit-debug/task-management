import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS } from '../src/instructions.js';

/**
 * The instructions are the only context a fresh agent session has.
 *
 * These assertions look pedantic and are not: each one corresponds to a mistake
 * that has actually been made against this server, or to a design decision that
 * is invisible from the tool schemas alone. Prose drifts under editing, and
 * quietly losing the batch-size warning or the "never guess an actual" line
 * costs real data.
 */

describe('the agent instructions', () => {
  it('lead with the one question the system answers', () => {
    expect(INSTRUCTIONS.slice(0, 200)).toContain('what is going');
    expect(INSTRUCTIONS.slice(0, 200)).toContain('slip');
  });

  it('teach the milestone / outcome-target distinction with a decision rule', () => {
    expect(INSTRUCTIONS).toContain('MILESTONE');
    expect(INSTRUCTIONS).toContain('OUTCOME TARGET');
    // A definition alone does not settle a borderline case; the test the agent
    // can actually apply is the one that matters.
    expect(INSTRUCTIONS).toContain('can Tal make this happen on his own?');
  });

  it('say to ask for the hours rather than assume them', () => {
    expect(INSTRUCTIONS).toMatch(/If Tal has not said how many hours/);
  });

  it('warn about batch size on commit_tasks', () => {
    // A 44-task commit failed in a way that could not be accounted for. Ten at
    // a time makes any failure isolable.
    expect(INSTRUCTIONS).toContain('BATCHES OF ABOUT TEN');
  });

  it('require idempotency keys and forbid blind retries', () => {
    expect(INSTRUCTIONS).toContain('idempotency_key ON EVERY WRITE');
    expect(INSTRUCTIONS).toContain('Re-send the SAME key');
  });

  it('explain that vacuous coverage is not reassuring', () => {
    expect(INSTRUCTIONS).toContain('vacuously 1.0');
    expect(INSTRUCTIONS).toContain('opposite of reassuring');
  });

  it('forbid inventing an actual duration', () => {
    expect(INSTRUCTIONS).toContain('Never estimate it yourself');
  });

  it('tell the agent to pass dependency order through', () => {
    expect(INSTRUCTIONS).toContain('depends_on');
    expect(INSTRUCTIONS).toContain('60%');
  });

  it('state that a pending document is not a filed one', () => {
    expect(INSTRUCTIONS).toContain('never describe a pending document as');
  });

  it('invite the agent to report what is missing, with the constraints', () => {
    expect(INSTRUCTIONS).toContain('suggest_improvement');
    // Without "from the occasion" this becomes a wishlist generator.
    expect(INSTRUCTIONS).toContain('FROM THE OCCASION');
    // And without this it becomes a reason to derail what Tal asked for.
    expect(INSTRUCTIONS).toContain('ONE sentence');
    // Feedback in the portfolio would corrupt the one question this answers.
    expect(INSTRUCTIONS).toContain('Feedback is NOT a task');
  });

  it('distinguish killing from closing, which nothing else can teach', () => {
    expect(INSTRUCTIONS).toContain('kill_task and close are NOT interchangeable');
    expect(INSTRUCTIONS).toContain('teaches');
  });

  it('say to look up a slug rather than guess it', () => {
    expect(INSTRUCTIONS).toContain('list_ventures');
    expect(INSTRUCTIONS).toContain('do not');
  });

  it('tell the agent to load the situation before asking about it', () => {
    expect(INSTRUCTIONS).toContain('CALL get_context() FIRST');
    // The point of the unknown list is that it is asked about, not filled in.
    expect(INSTRUCTIONS).toContain('do not fill any of it in from guesswork');
  });

  it('name link_tasks as the way to join an existing chain', () => {
    expect(INSTRUCTIONS).toContain('link_tasks');
    expect(INSTRUCTIONS).toContain('IN THAT CALL');
  });

  it('name next_actions as the answer to "what should I do now"', () => {
    expect(INSTRUCTIONS).toContain('next_actions');
    expect(INSTRUCTIONS).toContain('hard ceiling');
  });

  it('explain that the required rate is not inflation', () => {
    expect(INSTRUCTIONS).toContain('required_hours_total');
    expect(INSTRUCTIONS).toContain('not capped');
  });

  it('tell the agent to prepare rather than send', () => {
    expect(INSTRUCTIONS).toContain('mark_prepared');
    // The rule that keeps a fiction out of the system.
    expect(INSTRUCTIONS).toContain('NEVER close a task');
    expect(INSTRUCTIONS).toContain('drafted email is not a sent email');
  });

  it('name delegation as the largest lever, with the token rule', () => {
    expect(INSTRUCTIONS).toContain('delegate_link');
    // The whole reason delegation is worth building: 28 hours against 48.
    expect(INSTRUCTIONS).toContain('28');
    expect(INSTRUCTIONS).toContain('48');
    // Tal's rule, stated so an agent can tell somebody what the link will do.
    expect(INSTRUCTIONS).toContain('ONE LINK PER TASK');
    expect(INSTRUCTIONS).toContain('90 minutes');
    // Same discipline as mark_prepared: hand it over, do not claim to have sent.
    expect(INSTRUCTIONS).toContain('Never say you sent it');
  });

  it('say to read the delegation inbox before marking it read', () => {
    expect(INSTRUCTIONS).toContain('delegation_inbox');
    // A blocked delegate makes the week look LIGHTER if this is misunderstood.
    expect(INSTRUCTIONS).toContain('does NOT reduce demand');
    expect(INSTRUCTIONS).toContain('mark_read:true');
  });

  it('tell the agent to flag what it can draft, and why that matters', () => {
    expect(INSTRUCTIONS).toContain('day_plan');
    expect(INSTRUCTIONS).toContain('ai_preparable');
    // Without this it gets set from the title, and the plan books 15 minutes
    // where two hours were needed.
    expect(INSTRUCTIONS).toContain('only after');
    expect(INSTRUCTIONS).toContain('review_minutes');
  });

  it('name the page Tal can actually look at', () => {
    // The gap that made him say he did not have a task management system: every
    // other interface talks TO him.
    expect(INSTRUCTIONS).toContain('owner_link');
    expect(INSTRUCTIONS).toContain('bookmark');
  });

  it('keep the approval step in front of anything that reaches a person', () => {
    expect(INSTRUCTIONS).toContain('send_work_to_person');
    // The rule Tal stated: he is the final sender. A tool that delivered on
    // assignment would overturn it silently.
    expect(INSTRUCTIONS).toContain('ONLY WHEN HE SAYS SEND');
    expect(INSTRUCTIONS).toContain('verbatim');
  });

  it('stay short enough to survive a context window', () => {
    // Guidance nobody reads is guidance that does not exist. This is roughly
    // 1.5k tokens; well past that and it competes with the conversation.
    expect(INSTRUCTIONS.length).toBeLessThan(17000);
    expect(INSTRUCTIONS.length).toBeGreaterThan(2000);
  });
});
