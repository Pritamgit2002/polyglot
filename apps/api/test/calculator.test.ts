import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../src/tools/calculator.js';

describe('calculator', () => {
  it('respects precedence and associativity', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512); // right associative
    expect(evaluateExpression('-3 + 5')).toBe(2);
    expect(evaluateExpression('1.5e2 / 3')).toBe(50);
  });

  it('supports the whitelisted functions and constants', () => {
    expect(evaluateExpression('sqrt(16)')).toBe(4);
    expect(evaluateExpression('round(3.14159, 2)')).toBe(3.14);
    expect(evaluateExpression('max(1, 7, 3)')).toBe(7);
    expect(evaluateExpression('round(pi, 4)')).toBe(3.1416);
  });

  /**
   * The security case. These expressions would all execute under eval() or
   * new Function(); here they are parse errors, because the parser's only
   * possible output is a number.
   */
  it('refuses anything that is not arithmetic', () => {
    const attacks = [
      'process.env.ANTHROPIC_API_KEY',
      'require("fs").readFileSync("/etc/passwd")',
      'globalThis.fetch("http://evil.example")',
      '(()=>{while(true){}})()',
      'constructor.constructor("return 1")()',
      '1; console.log(1)',
      '__proto__',
    ];
    for (const a of attacks) {
      expect(() => evaluateExpression(a), a).toThrow();
    }
  });

  it('bounds runaway computation and rejects division by zero', () => {
    expect(() => evaluateExpression('9 ^ 9 ^ 9')).toThrow(/Exponent out of range/);
    expect(() => evaluateExpression('1 / 0')).toThrow(/Division by zero/);
    expect(() => evaluateExpression('1'.repeat(600))).toThrow(/too long/);
  });

  it('rejects malformed input instead of returning NaN', () => {
    expect(() => evaluateExpression('2 +')).toThrow();
    expect(() => evaluateExpression('(1 + 2')).toThrow();
    expect(() => evaluateExpression('2 2')).toThrow();
  });
});
