import { describe, it, expect } from "vitest";
import {
  extractTag,
  extractAllTags,
  parseTagChildren,
  parseAllTagObjects,
} from "../../src/llm/xml-parser.js";

describe("xml-parser", () => {
  describe("extractTag", () => {
    it("should extract content of a single tag", () => {
      expect(extractTag("<name>Alice</name>", "name")).toBe("Alice");
    });

    it("should return undefined when tag not found", () => {
      expect(extractTag("no tags here", "name")).toBeUndefined();
    });

    it("should extract from text with surrounding content", () => {
      const text = "Some preamble.\n<answer>42</answer>\nSome epilogue.";
      expect(extractTag(text, "answer")).toBe("42");
    });

    it("should trim whitespace", () => {
      expect(extractTag("<tag>  hello  </tag>", "tag")).toBe("hello");
    });

    it("should handle multiline content", () => {
      const text = "<reason>\nThis is\nmultiline\n</reason>";
      expect(extractTag(text, "reason")).toBe("This is\nmultiline");
    });

    it("should return first occurrence only", () => {
      const text = "<tag>first</tag> <tag>second</tag>";
      expect(extractTag(text, "tag")).toBe("first");
    });
  });

  describe("extractAllTags", () => {
    it("should extract all occurrences", () => {
      const text = "<item>a</item> <item>b</item> <item>c</item>";
      expect(extractAllTags(text, "item")).toEqual(["a", "b", "c"]);
    });

    it("should return empty array when no tags", () => {
      expect(extractAllTags("no tags", "item")).toEqual([]);
    });
  });

  describe("parseTagChildren", () => {
    it("should extract child tags from a block", () => {
      const block = "<question>What?</question><answer>That.</answer>";
      const result = parseTagChildren(block, ["question", "answer"]);
      expect(result.question).toBe("What?");
      expect(result.answer).toBe("That.");
    });

    it("should return undefined for missing children", () => {
      const block = "<question>What?</question>";
      const result = parseTagChildren(block, ["question", "answer"]);
      expect(result.question).toBe("What?");
      expect(result.answer).toBeUndefined();
    });
  });

  describe("parseAllTagObjects", () => {
    it("should parse multiple parent tags with children", () => {
      const text = `分析结果：
<anchor><question>你最看重什么？</question><answer>诚实</answer></anchor>
<anchor><question>你的梦想？</question><answer>自由</answer></anchor>`;
      const result = parseAllTagObjects(text, "anchor", ["question", "answer"]);
      expect(result).toHaveLength(2);
      expect(result[0].question).toBe("你最看重什么？");
      expect(result[0].answer).toBe("诚实");
      expect(result[1].question).toBe("你的梦想？");
      expect(result[1].answer).toBe("自由");
    });

    it("should return empty array when no parent tags", () => {
      const result = parseAllTagObjects("没有锚点", "anchor", ["question", "answer"]);
      expect(result).toEqual([]);
    });
  });
});
