/* eslint-disable no-useless-escape */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

/**
 * A shallow parser for JSON objects. 
 * This function parses a JSON object string and returns a JavaScript object with only top-level primitive values.
 * All nested objects and arrays are ignored.
 * @param {string} input 
 * @returns Object
 * @throws {TypeError} If the input is not a JSON object string.
 */

export default function shallowParse(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Input must be a string');
  }
  
  input = input.trim();
  if (!input.startsWith('{') || !input.endsWith('}')) {
    throw new SyntaxError('Input must be a JSON object');
  }
  
  const result = {};
  let i = 1; // skip '{'
  const len = input.length;
    
  while (i < len - 1) {
    // Skip whitespace
    while (/\s/.test(input[i])) i++;
  
    if (input[i] === '}') break; // end of object
    if (input[i] !== '"') throw new SyntaxError(`Expected key string at position ${i}`);
  
    // Parse key
    let key = '';
    i++; // skip opening quote
    while (i < len) {
      if (input[i] === '"') {
        let backslashes = 0;
        let j = i - 1;
        while (j >= 0 && input[j] === '\\') {
          backslashes++;
          j--;
        }
        if (backslashes % 2 === 0) break; // even number of backslashes = not escaped
      }
      key += input[i++];
    }
    i++; // skip closing quote
  
    // Skip whitespace and colon
    while (/\s/.test(input[i])) i++;
    if (input[i] !== ':') throw new SyntaxError(`Expected ':' after key at position ${i}`);
    i++; // skip ':'
    while (/\s/.test(input[i])) i++;
  
    // Parse value (only primitives allowed)
    let value;
    if (input[i] === '"') {
      // String value: grab the raw quoted string including escapes
      const start = i;
      i++; // skip opening quote
      while (i < len) {
        if (input[i] === '"') {
          let backslashes = 0;
          let j = i - 1;
          while (j >= 0 && input[j] === '\\') {
            backslashes++;
            j--;
          }
          if (backslashes % 2 === 0) break; // even number of backslashes = not escaped
        }
        i++;
      }
      i++; // skip closing quote
      const rawString = input.slice(start, i); // includes quotes
      value = JSON.parse(rawString); // safely handles all escape sequences
    } else if (/[\d\-]/.test(input[i])) {
      // Number
      let numStr = '';
      while (i < len && /[\dEe\+\-\.]/.test(input[i])) {
        numStr += input[i++];
      }
      value = Number(numStr);
    } else if (input.startsWith('true', i)) {
      value = true;
      i += 4;
    } else if (input.startsWith('false', i)) {
      value = false;
      i += 5;
    } else if (input.startsWith('null', i)) {
      value = null;
      i += 4;
    } else {
      // Non-primitive (array/object/invalid) → skip this value entirely
      let stack = [];
      if (input[i] === '{' || input[i] === '[') {
        stack.push(input[i]);
        i++;
        while (i < len && stack.length > 0) {
          if (input[i] === '"') {
            // Skip string inside object/array
            i++;
            while (i < len) {
              if (input[i] === '"') {
                let backslashes = 0;
                let j = i - 1;
                while (j >= 0 && input[j] === '\\') {
                  backslashes++;
                  j--;
                }
                if (backslashes % 2 === 0) break;
              }
              i++;
            }
            i++; // closing quote
          } else if (input[i] === '{' || input[i] === '[') {
            stack.push(input[i]);
            i++;
          } else if (input[i] === '}' && stack[stack.length - 1] === '{') {
            stack.pop();
            i++;
          } else if (input[i] === ']' && stack[stack.length - 1] === '[') {
            stack.pop();
            i++;
          } else {
            i++;
          }
        }
      } else {
        // Unknown token, skip until next comma or closing brace
        while (i < len && input[i] !== ',' && input[i] !== '}') i++;
      }
      value = undefined;
    }
  
    if (value !== undefined) {
      result[key] = value;
    }
  
    // Skip whitespace and comma
    while (/\s/.test(input[i])) i++;
    if (input[i] === ',') i++;
  }
  
  
  return result;
}
