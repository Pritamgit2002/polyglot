/**
 * Arithmetic evaluator — a hand-written recursive-descent parser.
 *
 * `eval()` and `new Function()` are off the table: the expression comes from a
 * model, and the model's input comes from a user and from retrieved document
 * text. Treating any of that as code is how you get `process.env` exfiltrated
 * through a calculator tool. This parser can only ever produce a number.
 */

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string } | { kind: 'ident'; value: string };

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sqrt: ([a]) => Math.sqrt(a!),
  abs: ([a]) => Math.abs(a!),
  round: ([a, d]) => {
    const f = 10 ** (d ?? 0);
    return Math.round(a! * f) / f;
  },
  floor: ([a]) => Math.floor(a!),
  ceil: ([a]) => Math.ceil(a!),
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  log: ([a, b]) => (b === undefined ? Math.log(a!) : Math.log(a!) / Math.log(b)),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const MAX_EXPRESSION_LENGTH = 500;

export function evaluateExpression(input: string): number {
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression too long (max ${MAX_EXPRESSION_LENGTH} characters).`);
  }

  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (value?: string): Token => {
    const t = tokens[pos];
    if (!t) throw new Error('Unexpected end of expression.');
    if (value && !(t.kind === 'op' && t.value === value)) throw new Error(`Expected "${value}".`);
    pos++;
    return t;
  };

  // expression := term (('+' | '-') term)*
  function parseExpression(): number {
    let left = parseTerm();
    while (true) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        eat();
        const right = parseTerm();
        left = t.value === '+' ? left + right : left - right;
      } else return left;
    }
  }

  // term := power (('*' | '/' | '%') power)*
  function parseTerm(): number {
    let left = parsePower();
    while (true) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        eat();
        const right = parsePower();
        if ((t.value === '/' || t.value === '%') && right === 0) throw new Error('Division by zero.');
        left = t.value === '*' ? left * right : t.value === '/' ? left / right : left % right;
      } else return left;
    }
  }

  // power := unary ('^' power)?   — right associative
  function parsePower(): number {
    const base = parseUnary();
    const t = peek();
    if (t?.kind === 'op' && t.value === '^') {
      eat();
      const exp = parsePower();
      // 9^9^9 is a trivial way to hang a process. Bound it.
      if (Math.abs(exp) > 1024) throw new Error('Exponent out of range.');
      return base ** exp;
    }
    return base;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.kind === 'op' && (t.value === '-' || t.value === '+')) {
      eat();
      const v = parseUnary();
      return t.value === '-' ? -v : v;
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression.');

    if (t.kind === 'num') {
      eat();
      return t.value;
    }

    if (t.kind === 'ident') {
      eat();
      const name = t.value.toLowerCase();

      if (peek()?.kind === 'op' && (peek() as { value: string }).value === '(') {
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`Unknown function "${t.value}".`);
        eat('(');
        const args: number[] = [];
        if (!(peek()?.kind === 'op' && (peek() as { value: string }).value === ')')) {
          args.push(parseExpression());
          while (peek()?.kind === 'op' && (peek() as { value: string }).value === ',') {
            eat(',');
            args.push(parseExpression());
          }
        }
        eat(')');
        return fn(args);
      }

      const constant = CONSTANTS[name];
      if (constant === undefined) throw new Error(`Unknown identifier "${t.value}".`);
      return constant;
    }

    if (t.value === '(') {
      eat('(');
      const v = parseExpression();
      eat(')');
      return v;
    }

    throw new Error(`Unexpected token "${t.value}".`);
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('Trailing input after expression.');
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number.');
  return result;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i]!;

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j]!)) j++;
      // Scientific notation: 1.5e-3
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k++;
        if (/[0-9]/.test(input[k] ?? '')) {
          while (k < input.length && /[0-9]/.test(input[k]!)) k++;
          j = k;
        }
      }
      const raw = input.slice(i, j).replace(/_/g, '');
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`Invalid number "${raw}".`);
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9]/.test(input[j]!)) j++;
      tokens.push({ kind: 'ident', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    throw new Error(`Illegal character "${c}" in expression.`);
  }

  return tokens;
}
