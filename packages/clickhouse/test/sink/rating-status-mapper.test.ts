import { describe, expect, it } from "vitest";

import { mapClickHouseOutbox } from "../../src/index.js";
import { normalized, record } from "./outbox-sink.fixtures.js";

describe("ClickHouse rating status mapper", () => {
  it("keeps current decision order stable across same-batch inserts and old replays", () => {
    const payload = (status: "provisional" | "official", stage: "provisional" | "official") => ({
      event_id: normalized.event_id,
      event_time: normalized.event_time,
      request_id: "request-1",
      attempt_id: "attempt-1",
      status,
      attempt_outcome: "success",
      deltas: [
        {
          rating_event_id: `rating-ordered:${stage}`,
          rating_sign: 1,
          rating_stage: stage,
          amount: "1.000000000000000000",
          currency: "USD",
          price_version_id: "price-version-1",
          calculation_version: "provider-cost",
          rating_fingerprint: `sha256:${"7".repeat(64)}`,
          reason: `${stage} fact`,
        },
      ],
    });
    const provisionalRecord = record(
      40n,
      "provider_cost.provisional",
      payload("provisional", "provisional"),
    );
    const officialRecord = record(
      41n,
      "provider_cost.official_delta",
      payload("official", "official"),
    );
    const replayRecord = {
      ...record(100n, "provider_cost.provisional", payload("provisional", "provisional")),
      replayOfOutboxId: 40n,
    };
    const facts = [provisionalRecord, officialRecord, replayRecord].map(
      (outbox) => mapClickHouseOutbox(outbox, { environment: "test" }).rows.rating_events![0]!,
    );

    expect(facts.map((fact) => fact.authority_outbox_id)).toEqual(["40", "41", "40"]);
    const latest = facts
      .toSorted((left, right) => {
        const authority =
          BigInt(left.authority_outbox_id as string) - BigInt(right.authority_outbox_id as string);
        if (authority !== 0n) return authority < 0n ? -1 : 1;
        return String(left.rating_event_id).localeCompare(String(right.rating_event_id));
      })
      .at(-1);
    expect(latest?.status).toBe("official");
  });

  it("keeps rating decision status separate from the attempt outcome used by aggregates", () => {
    const fact = (id: bigint, attemptOutcome: "success" | "failure", amount: string) =>
      mapClickHouseOutbox(
        record(id, "provider_cost.official_delta", {
          event_id: `${normalized.event_id}-${id.toString()}`,
          event_time: normalized.event_time,
          request_id: `request-${id.toString()}`,
          attempt_id: `attempt-${id.toString()}`,
          status: "official",
          attempt_outcome: attemptOutcome,
          deltas: [
            {
              rating_event_id: `rating-${id.toString()}:official`,
              rating_sign: 1,
              rating_stage: "official",
              amount,
              currency: "USD",
              price_version_id: "price-version-1",
              calculation_version: "provider-cost",
              rating_fingerprint: `sha256:${"6".repeat(64)}`,
              reason: "official provider cost rating",
            },
          ],
        }),
        { environment: "test" },
      ).rows.rating_events![0]!;
    const facts = [fact(50n, "success", "1"), fact(51n, "failure", "2")];

    expect(facts.map(({ status, attempt_outcome }) => ({ status, attempt_outcome }))).toEqual([
      { status: "official", attempt_outcome: "success" },
      { status: "official", attempt_outcome: "failure" },
    ]);
    const failedCost = facts
      .filter((row) => row.attempt_outcome !== "success")
      .reduce((sum, row) => sum + Number(row.rating_sign) * Number(row.amount_decimal), 0);
    expect(failedCost).toBe(2);
  });

  it("projects Provider Cost and AIU terminal outcomes instead of dropping them", () => {
    const provider = mapClickHouseOutbox(
      record(26n, "provider_cost.unpriced", {
        event_id: normalized.event_id,
        event_time: normalized.event_time,
        request_id: "request-1",
        attempt_id: "attempt-1",
        status: "unpriced",
        attempt_outcome: "success",
        deltas: [
          {
            rating_event_id: "rating-unpriced:status:1",
            rating_sign: 1,
            rating_stage: "unpriced",
            amount: null,
            currency: "USD",
            price_version_id: null,
            calculation_version: "provider-cost",
            rating_fingerprint: `sha256:${"f".repeat(64)}`,
            reason: "provider price is unavailable",
          },
        ],
      }),
      { environment: "test" },
    ).rows.rating_events![0]!;
    const aiu = mapClickHouseOutbox(
      record(27n, "aiu.decision", {
        event_id: normalized.event_id,
        event_time: normalized.event_time,
        request_id: "request-1",
        attempt_id: "attempt-1",
        status: "unrated",
        attempt_outcome: "success",
        deltas: [
          {
            rating_event_id: "rating-unrated:status:1",
            rating_sign: 1,
            rating_stage: "unrated",
            rating_fingerprint: `sha256:${"9".repeat(64)}`,
            aiu_rate_version_id: null,
            calculation_version: "aiu-rating",
            reason: "current unrated AIU decision",
            total_aiu_micros: null,
            lines: [],
          },
        ],
      }),
      { environment: "test" },
    ).rows.rating_events![0]!;

    expect(provider).toMatchObject({
      rating_kind: "provider_cost",
      rating_stage: "unpriced",
      status: "unpriced",
      amount_decimal: null,
    });
    expect(aiu).toMatchObject({
      rating_kind: "aiu",
      rating_stage: "unrated",
      status: "unrated",
      aiu_micros: null,
    });
  });
});
