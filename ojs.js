'use strict';

const fs = require('mz/fs');
const check = require('syntax-error');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

const ojsTemplate = function (filename) {
  this.filename = filename;
  this.source = '';
};

ojsTemplate.prototype = {
  compile: async function () {
    let text = (await fs.readFile(this.filename)).toString();
    text = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
    let lines = text.split('\n');

    this.rethrow = (err, lineno) => {
      let start = Math.max(lineno - 2, 0);
      let end = Math.min(lines.length, lineno + 10);

      // Error context
      let code = lines.slice(start, end).map((line, i) => {
        var curr = i + start + 1;
        return (curr == lineno ? ' >> ' : '    ') + (curr.toString().length < end.toString().length ? ' ' : '')+ curr + '| ' + line;
      }).join('\n');

      // Alter exception message
      if (typeof err === 'string') err = new Error(err);

      err.path = this.filename;

      if (err.stack) {
        let stackLines = err.stack.split('\n');
        let newStack = [];
        for (let line of stackLines) {
          if (line.match(/^\s*at (?:ojsTemplate\.)rethrow/)) {
            newStack.push('    at OJS template (' + this.filename + ':' + lineno + ')\n\n' + code);
            break;
          } else if (line.match(/^\s*at Object.eval \(eval at render /)) {
            newStack.push('    at OJS template (' + this.filename + ':' + lineno + ')\n\n' + code);
            break;
          }
          newStack.push(line);
        }
        err.message = newStack.join('\n');
      } else {
        err.message = 'Error: ' + err.message + '\n    at OJS template (' + this.filename + ':' + lineno + ')\n\n' + code;
      }

      throw err;
    }

    let cur = 0; // current character through file
    let line = 1; // current line through file
    let start = 0; // start character of current chunk
    let state = 'html'; // html, js, scomment, mcomment, squote, dquote, backtick
    let source = [];

    // sniff the string from cur for the next chars matching string
    const expect = (string, moveCur = true) => {
      const len = string.length;
      if (text.substring(cur, cur + len) === string) {
        if (moveCur) cur += len;
        return true;
      } else {
        return false;
      }
    }
    const appendAndSkip = (skip = 0) => {
      if (start !== cur) {
        let code = text.substring(start, cur);
        if (state === 'js') {
          if (code[0] === '=') {
            source.push('await print(' + code.substr(1).replace(/;\s*$/, '') + ');');
          } else {
            source.push(code);
          }
        } else if (state === 'html') {
          source.push('await print(' + JSON.stringify(code) + ');');
        }
      }
      cur += skip;
      start = cur;
    };
    const nl = () => {
      line++;
      if (state !== 'js') source.push('\n');
    };

    while (cur < text.length) {
      switch (state) {
        case 'html':
          if (expect('\n')) {
            appendAndSkip();
            nl();
          } else if (expect('<?', false)) {
            appendAndSkip(2);
            source.push('__line=' + line + ';');
            state = 'js';
          } else {
            cur++;
          }
        break;
        case 'js':
          if (expect('\n')) {
            nl();
          } else if (expect('\\')) {
            cur++; // skip escaped char
          } else if (expect("'")) {
            state = 'squote';
          } else if (expect('"')) {
            state = 'dquote';
          } else if (expect('`')) {
            state = 'backtick';
          } else if (expect('/*', false)) {
            appendAndSkip(2);
            state = 'mcomment';
          } else if (expect('//', false)) {
            appendAndSkip(2);
            state = 'scomment';
          } else if (expect('?>', false)) {
            appendAndSkip(2);
            state = 'html';
            if (expect('\n')) {
              nl();
              start = cur;
            }
          } else {
            cur++;
          }
        break;
        case 'squote':
          if (expect('\\')) {
            cur++; // escaped char, move forward
          } else if (expect("'")) {
            state = 'js';
          } else {
            cur++;
          }
        break;
        case 'dquote':
          if (expect('\\')) {
            cur++; // escaped char, move forward
          } else if (expect('"')) {
            state = 'js';
          } else {
            cur++;
          }
        break;
        case 'backtick':
          if (expect('\\')) {
            cur++; // escaped char, move forward
          } else if (expect('`')) {
            state = 'js';
          } else {
            cur++;
          }
        break;
        case 'mcomment':
          if (expect('\n')) {
            nl(); // pad new line in multiline comment
          } else if (expect('*/')) {
            state = 'js';
            start = cur; // move cursor so we don't print comment into source
          } else {
            cur++;
          }
        break;
        case 'scomment':
          if (expect('\n')) {
            nl();
            state = 'js';
            start = cur; // move cursor so we don't print comment into source
          } else {
            cur++;
          }
        break;
        default:
          throw 'Unexpected state ' + state;
      }
    }
    switch (state) {
      case 'html':
        appendAndSkip();
      break;
      case 'js':
      case 'squote':
      case 'dquote':
      case 'backtick':
      case 'mcomment':
        this.rethrow('Unexpected end of file', lines.length);
      break;
    }

    // joining arrays is slightly faster than appending strings
    this.source = source.join('');

    // use syntax-error to check the compiled source code
    let syntaxError = check('(async function () {' + this.source + '})();', this.filename);
    if (syntaxError) this.rethrow(syntaxError, syntaxError.line);

    // wrap our source in a try catch with using our rethrower function
    this.source = 'let __line = 0; try {' + this.source + '} catch (e) {rethrow(e, __line);}';
  },
  render: async function (context) {
    // setup context scopes for templates
    let argNames = ['rethrow'];
    let args = [this.rethrow];
    for (let key in context) {
      // bind functions and assign variables to scope
      argNames.push(key);
      if (typeof context[key] === 'function') {
        args.push(context[key].bind(context));
      } else {
        args.push(context[key]);
      }
    }

    // create our function using the constructor, taking our scope arg names
    const fn = new AsyncFunction(argNames.join(', '), this.source);
    await fn.apply({}, args); // run the function
  }
};

module.exports = {
  renderFile: async (writeStream, filename, context) => {
    if (!writeStream.on || !writeStream.write) {
      throw new Error('ojs.renderFile(writeStream, filename, context): expects first argument to be a writable stream');
    }
    if (await fs.exists(filename) === false) {
      throw new Error('ojs.renderFile(writeStream, filename, context): filename does not exist, was given: ' + filename);
    }
    if (typeof context !== 'object') {
      throw new Error('ojs.renderFile(writeStream, filename, context): context must be an object, was given: ' + typeof context);
    }

    // setup stream handling
    let streamOpen = true;
    if (!writeStream.__osirisHooked) {
      writeStream.__osirisHooked = true;
      const onClose = () => { streamOpen = false; if (context.onClose) context.onClose.apply(context); };
      writeStream.on('close', onClose); // close is needed for sockets
      writeStream.on('end', onClose); // end is needed for stream buffers
    }

    const print = async (text) => {
      // write directly to stream, return/resolve an empty string
      text = await text;
      text = text.toString();
      if (text.length === 0) return '';

      return new Promise((res, rej) => {
        const resolve = () => res('');

        try {
          if (!writeStream.write(text)) { // returns false if buffering output
            writeStream.once('drain', resolve); // resolve once stream is drained
          } else {
            process.nextTick(resolve); // resolve on next tick, allow other requests to finish
          }
        } catch (e) {
          resolve(); // silence write errors
        }
      });
    };

    // inject print function into context
    context.print = print.bind(context);

    let template = new ojsTemplate(filename)
    try {
      await template.compile();
      await template.render(context);
    } catch (e) {
      // console.log(e.message);
      context.print('<pre>' + e.message.replace(/</g, '&lt;') + '</pre>');
    }
  }
};
