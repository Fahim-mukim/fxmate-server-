import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  DEFAULT_LIMIT as EXPORTED_DEFAULT_LIMIT,
  escapeRegex,
  parseServiceListQuery,
} from "../src/services/serviceQuery.js";
import { isValidObjectId } from "../src/services/serviceModel.js";

test("parseServiceListQuery applies safe defaults", () => {
  assert.deepEqual(parseServiceListQuery({}), {
    search: null,
    category: null,
    serviceMode: null,
    minPrice: null,
    maxPrice: null,
    sort: "newest",
    page: DEFAULT_PAGE,
    limit: DEFAULT_LIMIT,
  });
  assert.equal(EXPORTED_DEFAULT_LIMIT, 12);
});

test("parseServiceListQuery accepts a fully valid query", () => {
  const parsed = parseServiceListQuery({
    search: "  screen repair  ",
    category: "Smartphone",
    serviceMode: "Home Visit",
    minPrice: "50.50",
    maxPrice: "200",
    sort: "price-desc",
    page: "2",
    limit: "24",
  });

  assert.deepEqual(parsed, {
    search: "screen repair",
    category: "Smartphone",
    serviceMode: "Home Visit",
    minPrice: 50.5,
    maxPrice: 200,
    sort: "price-desc",
    page: 2,
    limit: 24,
  });
});

test("parseServiceListQuery rejects unknown and operator-style parameters", () => {
  assert.throws(
    () => parseServiceListQuery({ approvalStatus: "approved" }),
    /Unsupported query parameter/,
  );
  assert.throws(
    () => parseServiceListQuery({ "category[$ne]": "Smartphone" }),
    /Unsupported query parameter/,
  );
  assert.throws(
    () => parseServiceListQuery({ category: { $ne: "Smartphone" } }),
    /must be a single string/,
  );
  assert.throws(
    () => parseServiceListQuery({ category: ["Smartphone", "AC"] }),
    /must be a single string/,
  );
});

test("parseServiceListQuery rejects invalid enums and unsupported sorts", () => {
  assert.throws(
    () => parseServiceListQuery({ category: "Unknown" }),
    /category is not supported/,
  );
  assert.throws(
    () => parseServiceListQuery({ serviceMode: "Teleport" }),
    /serviceMode is not supported/,
  );
  assert.throws(
    () => parseServiceListQuery({ sort: "highest-rated" }),
    /sort is not supported/,
  );
});

test("parseServiceListQuery rejects invalid numeric parameters", () => {
  const invalidQueries = [
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "100001" },
    { limit: "0" },
    { limit: "-5" },
    { limit: "51" },
    { minPrice: "-1" },
    { maxPrice: "abc" },
    { minPrice: "1e3" },
    { minPrice: "Infinity" },
    { minPrice: "200", maxPrice: "100" },
  ];

  for (const query of invalidQueries) {
    assert.throws(() => parseServiceListQuery(query));
  }
});

test("parseServiceListQuery limits search length", () => {
  assert.throws(
    () => parseServiceListQuery({ search: "x".repeat(101) }),
    /at most 100 characters/,
  );
});

test("escapeRegex neutralizes regex metacharacters and operator-like text", () => {
  assert.equal(escapeRegex("$ne.*[x]"), "\\$ne\\.\\*\\[x\\]");
});

test("isValidObjectId accepts 24 hex characters and rejects other shapes", () => {
  assert.equal(isValidObjectId("507f1f77bcf86cd799439011"), true);
  assert.equal(isValidObjectId("507f1f77bcf86cd79943901"), false);
  assert.equal(isValidObjectId("abcdefghijklmnopqrstuvwx"), false);
  assert.equal(isValidObjectId({ $ne: null }), false);
});
