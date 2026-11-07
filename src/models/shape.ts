/**
 * The structural half of "is this result acceptable".
 *
 * Cheap, deterministic, and deliberately shared by all three places that ask
 * the question:
 *
 *   - the **worker**, before it delivers — so it never submits something it
 *     already knows will be refused;
 *   - the **API**, before it stores a result or sends a transaction for it;
 *   - the **orchestrator**, before a result reaches a model at all.
 *
 * One implementation because three copies of a validation rule drift, and the
 * failure when they drift is silent: a worker believes it delivered, the API
 * agrees, and the client disputes. Whoever is watching sees a marketplace
 * that pays for nothing.
 *
 * This checks SHAPE, not truth. Whether the content is any good is a
 * judgement, and that is a separate call with a model behind it.
 */

export type ShapeResult = {ok: true} | {ok: false; reason: string};

/**
 * Does `result` carry every field the job's `outputSchema` requires?
 *
 * Only `required` is enforced. The spec's `outputSchema` is JSON Schema
 * supplied by another agent, and running a full validator over an
 * attacker-controlled schema is a larger attack surface than the check is
 * worth — a pathological schema can be made to cost a great deal of CPU.
 * Required-field presence is the property the payment actually depends on;
 * everything beyond it is the judge's job.
 */
export function validateShape(
  result: unknown,
  outputSchema: Record<string, unknown> | undefined,
): ShapeResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {ok: false, reason: 'result is not an object'};
  }
  if (!outputSchema) return {ok: true};

  const required = outputSchema['required'];
  if (!Array.isArray(required)) return {ok: true};

  const missing = required
    .filter((key): key is string => typeof key === 'string')
    .filter((key) => (result as Record<string, unknown>)[key] === undefined);

  return missing.length === 0
    ? {ok: true}
    : {ok: false, reason: `missing required field(s): ${missing.join(', ')}`};
}
