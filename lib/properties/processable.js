
// Contains the interpretation of CSS properties, as used by the property optimizer


module.exports = (function () {

  var tokenModule = require('./token');
  var validator = require('./validator');

  // Functions that decide what value can override what.
  // The main purpose is to disallow removing CSS fallbacks.
  // A separate implementation is needed for every different kind of CSS property.
  // -----
  // The generic idea is that properties that have wider browser support are 'more understandable'
  // than others and that 'less understandable' values can't override more understandable ones.
  var canOverride = {
    // Use when two tokens of the same property can always be merged
    always: function () {
      // NOTE: We could have (val1, val2) parameters here but jshint complains because we don't use them
      return true;
    },
    // Use when two tokens of the same property can only be merged if they have the same value
    sameValue: function(val1, val2) {
      return val1 === val2;
    },
    sameFunctionOrValue: function(val1, val2) {
      // Functions with the same name can override each other
      if (validator.areSameFunction(val1, val2)) {
        return true;
      }

      return val1 === val2;
    },
    // Use for properties containing CSS units (margin-top, padding-left, etc.)
    unit: function(val1, val2) {
      // The idea here is that 'more understandable' values override 'less understandable' values, but not vice versa
      // Understandability: (unit without functions) > (same functions | standard functions) > anything else
      // NOTE: there is no point in having different vendor-specific functions override each other or standard functions,
      //       or having standard functions override vendor-specific functions, but standard functions can override each other
      // NOTE: vendor-specific property values are not taken into consideration here at the moment

      if (validator.isValidUnitWithoutFunction(val2))
        return true;
      if (validator.isValidUnitWithoutFunction(val1))
        return false;

      // Standard non-vendor-prefixed functions can override each other
      if (validator.isValidFunctionWithoutVendorPrefix(val2) && validator.isValidFunctionWithoutVendorPrefix(val1)) {
        return true;
      }

      // Functions with the same name can override each other; same values can override each other
      return canOverride.sameFunctionOrValue(val1, val2);
    },
    // Use for color properties (color, background-color, border-color, etc.)
    color: function(val1, val2) {
      // The idea here is that 'more understandable' values override 'less understandable' values, but not vice versa
      // Understandability: (hex | named) > (rgba | hsla) > (same function name) > anything else
      // NOTE: at this point rgb and hsl are replaced by hex values by clean-css

      // (hex | named)
      if (validator.isValidNamedColor(val2) || validator.isValidHexColor(val2))
        return true;
      if (validator.isValidNamedColor(val1) || validator.isValidHexColor(val1))
        return false;

      // (rgba|hsla)
      if (validator.isValidRgbaColor(val2) || validator.isValidHslaColor(val2))
        return true;
      if (validator.isValidRgbaColor(val1) || validator.isValidHslaColor(val1))
        return false;

      // Functions with the same name can override each other; same values can override each other
      return canOverride.sameFunctionOrValue(val1, val2);
    },
    // Use for background-image
    backgroundImage: function(val1, val2) {
      // The idea here is that 'more understandable' values override 'less understandable' values, but not vice versa
      // Understandability: (none | url | inherit) > (same function) > (same value)

      // (none | url)
      if (val2 === 'none' || val2 === 'inherit' || validator.isValidUrl(val2))
        return true;
      if (val1 === 'none' || val1 === 'inherit' || validator.isValidUrl(val1))
        return false;

      // Functions with the same name can override each other; same values can override each other
      return canOverride.sameFunctionOrValue(val1, val2);
    },
    border: function(val1, val2) {
      var brokenUp1 = breakUp.border(Token.tokenizeOne(val1));
      var brokenUp2 = breakUp.border(Token.tokenizeOne(val2));

      return canOverride.color(brokenUp1[2].value, brokenUp2[2].value);
    }
  };
  canOverride = Object.freeze(canOverride);

  // Functions for breaking up shorthands to components
  var breakUp = {};
  breakUp.takeCareOfFourValues = function (splitfunc) {
    return function (token) {
      var descriptor = processable[token.prop];
      var result = [];
      var splitval = splitfunc(token.value);

      if (splitval.length === 0 || (splitval.length < descriptor.components.length && descriptor.components.length > 4)) {
        // This token is malformed and we have no idea how to fix it. So let's just keep it intact
        return [token];
      }

      // Fix those that we do know how to fix
      if (splitval.length < descriptor.components.length && splitval.length < 2) {
        // foo{margin:1px} -> foo{margin:1px 1px}
        splitval[1] = splitval[0];
      }
      if (splitval.length < descriptor.components.length && splitval.length < 3) {
        // foo{margin:1px 2px} -> foo{margin:1px 2px 1px}
        splitval[2] = splitval[0];
      }
      if (splitval.length < descriptor.components.length && splitval.length < 4) {
        // foo{margin:1px 2px 3px} -> foo{margin:1px 2px 3px 2px}
        splitval[3] = splitval[1];
      }

      // Now break it up to its components
      for (var i = 0; i < descriptor.components.length; i++) {
        var t = new Token(descriptor.components[i], splitval[i], token.isImportant);
        result.push(t);
      }

      return result;
    };
  };
  // Use this for properties with 4 unit values (like margin or padding)
  // NOTE: it handles shorter forms of these properties too (like, only 1, 2, or 3 units)
  breakUp.fourUnits = breakUp.takeCareOfFourValues(function (val) {
    return val.match(new RegExp(validator.cssUnitAnyRegexStr, 'gi'));
  });
  // Use this when you simply want to break up four values along spaces
  breakUp.fourBySpaces = breakUp.takeCareOfFourValues(function (val) {
    return val.split(' ').filter(function (v) { return v; });
  });
  // Use this for non-length values that can also contain functions
  breakUp.fourBySpacesOrFunctions = breakUp.takeCareOfFourValues(function (val) {
    var result = [];
    var curr = '';
    var parenthesisLevel = 0;
    var valLength = val.length;

    for (var i = 0; i < valLength; i++) {
      var c = val[i];
      curr += c;

      if (c === '(') {
        parenthesisLevel++;
      } else if (c === ')') {
        parenthesisLevel--;
        if (parenthesisLevel === 0) {
          result.push(curr.trim());
          curr = '';
        }
      } else if (c === ' ' && parenthesisLevel === 0) {
        curr = curr.trim();
        if (curr !== '') {
          result.push(curr);
          curr = '';
        }
      }
    }

    if (curr) {
      result.push(curr.trim());
      curr = '';
    }

    return result;
  });
  // Breaks up a background property value
  breakUp.background = function (token) {
    // Default values
    var result = Token.makeDefaults(['background-color', 'background-image', 'background-repeat', 'background-position', 'background-attachment'], token.isImportant);
    var color = result[0], image = result[1], repeat = result[2], position = result[3], attachment = result[4];

    // Take care of inherit
    if (token.value === 'inherit') {
      // NOTE: 'inherit' is not a valid value for background-attachment so there we'll leave the default value
      color.value = image.value =  repeat.value = position.value = attachment.value = 'inherit';
      return result;
    }

    // Break the background up into parts
    var parts = token.value.split(' ');
    if (parts.length === 0)
      return result;

    // The trick here is that we start going through the parts from the end, then stop after background repeat,
    // then start from the from the beginning until we find a valid color value. What remains will be treated as background-image.

    var currentIndex = parts.length - 1;
    var current = parts[currentIndex];
    // Attachment
    if (validator.isValidBackgroundAttachment(current)) {
      // Found attachment
      attachment.value = current;
      currentIndex--;
      current = parts[currentIndex];
    }
    // Position
    var pos = parts[currentIndex - 1] + ' ' + parts[currentIndex];
    if (currentIndex >= 1 && validator.isValidBackgroundPosition(pos)) {
      // Found position (containing two parts)
      position.value = pos;
      currentIndex -= 2;
      current = parts[currentIndex];
    } else if (currentIndex >= 0 && validator.isValidBackgroundPosition(current)) {
      // Found position (containing just one part)
      position.value = current;
      currentIndex--;
      current = parts[currentIndex];
    }
    // Repeat
    if (currentIndex >= 0 && validator.isValidBackgroundRepeat(current)) {
      // Found repeat
      repeat.value = current;
      currentIndex--;
      current = parts[currentIndex];
    }
    // Color
    var fromBeginning = 0;
    if (validator.isValidColor(parts[0])) {
      // Found color
      color.value = parts[0];
      fromBeginning = 1;
    }
    // Image
    image.value = (parts.splice(fromBeginning, currentIndex - fromBeginning + 1).join(' ')) || 'none';

    return result;
  };
  // Breaks up a list-style property value
  breakUp.listStyle = function (token) {
    // Default values
    var result = Token.makeDefaults(['list-style-type', 'list-style-position', 'list-style-image'], token.isImportant);
    var type = result[0], position = result[1], image = result[2];

    if (token.value === 'inherit') {
      type.value = position.value = image.value = 'inherit';
      return result;
    }

    var parts = token.value.split(' ');
    var ci = 0;

    // Type
    if (ci < parts.length && validator.isValidListStyleType(parts[ci])) {
      type.value = parts[ci];
      ci++;
    }
    // Position
    if (ci < parts.length && validator.isValidListStylePosition(parts[ci])) {
      position.value = parts[ci];
      ci++;
    }
    // Image
    if (ci < parts.length) {
      image.value = parts.splice(ci, parts.length - ci + 1).join(' ');
    }

    return result;
  };

  breakUp._widthStyleColor = function(token, prefix, order) {
    // Default values
    var components = order.map(function(prop) {
      return prefix + '-' + prop;
    });
    var result = Token.makeDefaults(components, token.isImportant);
    var color = result[order.indexOf('color')];
    var style = result[order.indexOf('style')];
    var width = result[order.indexOf('width')];

    // Take care of inherit
    if (token.value === 'inherit' || token.value === 'inherit inherit inherit') {
      color.value = style.value = width.value = 'inherit';
      return result;
    }

    // NOTE: usually users don't follow the required order of parts in this shorthand,
    // so we'll try to parse it caring as little about order as possible

    var parts = token.value.split(' '), w;

    if (parts.length === 0) {
      return result;
    }

    if (parts.length >= 1) {
      // Try to find -width, excluding inherit because that can be anything
      w = parts.filter(function(p) { return p !== 'inherit' && validator.isValidOutlineWidth(p); });
      if (w.length) {
        width.value = w[0];
        parts.splice(parts.indexOf(w[0]), 1);
      }
    }
    if (parts.length >= 1) {
      // Try to find -style, excluding inherit because that can be anything
      w = parts.filter(function(p) { return p !== 'inherit' && validator.isValidOutlineStyle(p); });
      if (w.length) {
        style.value = w[0];
        parts.splice(parts.indexOf(w[0]), 1);
      }
    }
    if (parts.length >= 1) {
      // Find -color but this time can catch inherit
      w = parts.filter(function(p) { return validator.isValidOutlineColor(p); });
      if (w.length) {
        color.value = w[0];
        parts.splice(parts.indexOf(w[0]), 1);
      }
    }

    return result;
  };

  breakUp.outline = function(token) {
    return breakUp._widthStyleColor(token, 'outline', ['color', 'style', 'width']);
  };

  breakUp.border = function(token) {
    return breakUp._widthStyleColor(token, 'border', ['width', 'style', 'color']);
  };

  breakUp.borderRadius = function(token) {
    var parts = token.value.split('/');
    if (parts.length == 1)
      return breakUp.fourUnits(token);

    var horizontalPart = token.clone();
    var verticalPart = token.clone();

    horizontalPart.value = parts[0];
    verticalPart.value = parts[1];

    var horizontalBreakUp = breakUp.fourUnits(horizontalPart);
    var verticalBreakUp = breakUp.fourUnits(verticalPart);

    for (var i = 0; i < 4; i++) {
      horizontalBreakUp[i].value = [horizontalBreakUp[i].value, verticalBreakUp[i].value];
    }

    return horizontalBreakUp;
  };

  // Contains functions that can put together shorthands from their components
  // NOTE: correct order of tokens is assumed inside these functions!
  var putTogether = {
    // Use this for properties which have four unit values (margin, padding, etc.)
    // NOTE: optimizes to shorter forms too (that only specify 1, 2, or 3 values)
    fourUnits: function (prop, tokens, isImportant) {
      // See about irrelevant tokens
      // NOTE: This will enable some crazy optimalizations for us.
      if (tokens[0].isIrrelevant)
        tokens[0].value = tokens[2].value;
      if (tokens[2].isIrrelevant)
        tokens[2].value = tokens[0].value;
      if (tokens[1].isIrrelevant)
        tokens[1].value = tokens[3].value;
      if (tokens[3].isIrrelevant)
        tokens[3].value = tokens[1].value;

      if (tokens[0].isIrrelevant && tokens[2].isIrrelevant) {
        if (tokens[1].value === tokens[3].value)
          tokens[0].value = tokens[2].value = tokens[1].value;
        else
          tokens[0].value = tokens[2].value = '0';
      }
      if (tokens[1].isIrrelevant && tokens[3].isIrrelevant) {
        if (tokens[0].value === tokens[2].value)
          tokens[1].value = tokens[3].value = tokens[0].value;
        else
          tokens[1].value = tokens[3].value = '0';
      }

      var result = new Token(prop, tokens[0].value, isImportant);
      result.granularValues = [];
      result.granularValues[tokens[0].prop] = tokens[0].value;
      result.granularValues[tokens[1].prop] = tokens[1].value;
      result.granularValues[tokens[2].prop] = tokens[2].value;
      result.granularValues[tokens[3].prop] = tokens[3].value;

      // If all of them are irrelevant
      if (tokens[0].isIrrelevant && tokens[1].isIrrelevant && tokens[2].isIrrelevant && tokens[3].isIrrelevant) {
        result.value = processable[prop].shortestValue || processable[prop].defaultValue;
        return result;
      }

      // 1-value short form: all four components are equal
      if (tokens[0].value === tokens[1].value && tokens[0].value === tokens[2].value && tokens[0].value === tokens[3].value) {
        return result;
      }
      result.value += ' ' + tokens[1].value;
      // 2-value short form: first and third; second and fourth values are equal
      if (tokens[0].value === tokens[2].value && tokens[1].value === tokens[3].value) {
        return result;
      }
      result.value += ' ' + tokens[2].value;
      // 3-value short form: second and fourth values are equal
      if (tokens[1].value === tokens[3].value) {
        return result;
      }
      // 4-value form (none of the above optimalizations could be accomplished)
      result.value += ' ' + tokens[3].value;
      return result;
    },
    // Puts together the components by spaces and omits default values (this is the case for most shorthands)
    bySpacesOmitDefaults: function (prop, tokens, isImportant) {
      var result = new Token(prop, '', isImportant);
      // Get irrelevant tokens
      var irrelevantTokens = tokens.filter(function (t) { return t.isIrrelevant; });

      // If every token is irrelevant, return shortest possible value, fallback to default value
      if (irrelevantTokens.length === tokens.length) {
        result.isIrrelevant = true;
        result.value = processable[prop].shortestValue || processable[prop].defaultValue;
        return result;
      }

      // This will be the value of the shorthand if all the components are default
      var valueIfAllDefault = processable[prop].defaultValue;

      // Go through all tokens and concatenate their values as necessary
      for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];

        // Set granular value so that other parts of the code can use this for optimalization opportunities
        result.granularValues = result.granularValues || { };
        result.granularValues[token.prop] = token.value;

        // Use irrelevant tokens for optimalization opportunity
        if (token.isIrrelevant) {
          // Get shortest possible value, fallback to default value
          var tokenShortest = processable[token.prop].shortestValue || processable[token.prop].defaultValue;
          // If the shortest possible value of this token is shorter than the default value of the shorthand, use it instead
          if (tokenShortest.length < valueIfAllDefault.length) {
            valueIfAllDefault = tokenShortest;
          }
        }

        // Omit default / irrelevant value
        if (token.isIrrelevant || (processable[token.prop] && processable[token.prop].defaultValue === token.value)) {
          continue;
        }

        result.value += ' ' + token.value;
      }

      result.value = result.value.trim();
      if (!result.value) {
        result.value = valueIfAllDefault;
      }

      return result;
    },
    // Handles the cases when some or all the fine-grained properties are set to inherit
    takeCareOfInherit: function (innerFunc) {
      return function (prop, tokens, isImportant) {
        // Filter out the inheriting and non-inheriting tokens in one iteration
        var inheritingTokens = [];
        var nonInheritingTokens = [];
        var result2Shorthandable = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
          if (tokens[i].value === 'inherit') {
            inheritingTokens.push(tokens[i]);

            // Indicate that this property is irrelevant and its value can safely be set to anything else
            var r2s = new Token(tokens[i].prop, tokens[i].isImportant);
            r2s.isIrrelevant = true;
            result2Shorthandable.push(r2s);
          } else {
            nonInheritingTokens.push(tokens[i]);
            result2Shorthandable.push(tokens[i]);
          }
        }

        if (nonInheritingTokens.length === 0) {
          // When all the tokens are 'inherit'
          return new Token(prop, 'inherit', isImportant);
        } else if (inheritingTokens.length > 0) {
          // When some (but not all) of the tokens are 'inherit'

          // Result 1. Shorthand just the inherit values and have it overridden with the non-inheriting ones
          var result1 = [new Token(prop, 'inherit', isImportant)].concat(nonInheritingTokens);

          // Result 2. Shorthand every non-inherit value and then have it overridden with the inheriting ones
          var result2 = [innerFunc(prop, result2Shorthandable, isImportant)].concat(inheritingTokens);

          // Return whichever is shorter
          var dl1 = Token.getDetokenizedLength(result1);
          var dl2 = Token.getDetokenizedLength(result2);

          return dl1 < dl2 ? result1 : result2;
        } else {
          // When none of tokens are 'inherit'
          return innerFunc(prop, tokens, isImportant);
        }
      };
    },
    borderRadius: function (prop, tokens, isImportant) {
      var verticalTokens = [];

      for (var i = 0, l = tokens.length; i < l; i++) {
        var token = tokens[i];
        if (!Array.isArray(token.value))
          continue;

        if (token.value.length > 1) {
          verticalTokens.push({
            prop: token.prop,
            value: token.value[1],
            isImportant: token.isImportant
          });
        }

        token.value = token.value[0];
      }

      var result = putTogether.takeCareOfInherit(putTogether.fourUnits)(prop, tokens, isImportant);
      if (verticalTokens.length > 0) {
        var verticalResult = putTogether.takeCareOfInherit(putTogether.fourUnits)(prop, verticalTokens, isImportant);
        if (result.value != verticalResult.value)
          result.value += '/' + verticalResult.value;
      }

      return result;
    }
  };

  // Properties to process
  // Extend this object in order to add support for more properties in the optimizer.
  //
  // Each key in this object represents a CSS property and should be an object.
  // Such an object contains properties that describe how the represented CSS property should be handled.
  // Possible options:
  //
  // * components: array (Only specify for shorthand properties.)
  //   Contains the names of the granular properties this shorthand compacts.
  //
  // * canOverride: function (Default is canOverride.sameValue - meaning that they'll only be merged if they have the same value.)
  //   Returns whether two tokens of this property can be merged with each other.
  //   This property has no meaning for shorthands.
  //
  // * defaultValue: string
  //   Specifies the default value of the property according to the CSS standard.
  //   For shorthand, this is used when every component is set to its default value, therefore it should be the shortest possible default value of all the components.
  //
  // * shortestValue: string
  //   Specifies the shortest possible value the property can possibly have.
  //   (Falls back to defaultValue if unspecified.)
  //
  // * breakUp: function (Only specify for shorthand properties.)
  //   Breaks the shorthand up to its components.
  //
  // * putTogether: function (Only specify for shorthand properties.)
  //   Puts the shorthand together from its components.
  //
  var processable = {
    'color': {
      canOverride: canOverride.color,
      defaultValue: 'transparent',
      shortestValue: 'red'
    },
    // background ------------------------------------------------------------------------------
    'background': {
      components: [
        'background-color',
        'background-image',
        'background-repeat',
        'background-position',
        'background-attachment'
      ],
      breakUp: breakUp.background,
      putTogether: putTogether.takeCareOfInherit(putTogether.bySpacesOmitDefaults),
      defaultValue: '0 0',
      shortestValue: '0'
    },
    'background-color': {
      canOverride: canOverride.color,
      defaultValue: 'transparent',
      shortestValue: 'red'
    },
    'background-image': {
      canOverride: canOverride.backgroundImage,
      defaultValue: 'none'
    },
    'background-repeat': {
      canOverride: canOverride.always,
      defaultValue: 'repeat'
    },
    'background-position': {
      canOverride: canOverride.always,
      defaultValue: '0 0',
      shortestValue: '0'
    },
    'background-attachment': {
      canOverride: canOverride.always,
      defaultValue: 'scroll'
    },
    'border': {
      breakUp: breakUp.border,
      canOverride: canOverride.border,
      components: [
        'border-width',
        'border-style',
        'border-color'
      ],
      defaultValue: 'none',
      putTogether: putTogether.takeCareOfInherit(putTogether.bySpacesOmitDefaults)
    },
    'border-color': {
      canOverride: canOverride.color,
      defaultValue: 'none'
    },
    'border-style': {
      canOverride: canOverride.always,
      defaultValue: 'none'
    },
    'border-width': {
      canOverride: canOverride.unit,
      defaultValue: 'medium',
      shortestValue: '0'
    },
    // list-style ------------------------------------------------------------------------------
    'list-style': {
      components: [
        'list-style-type',
        'list-style-position',
        'list-style-image'
      ],
      canOverride: canOverride.always,
      breakUp: breakUp.listStyle,
      putTogether: putTogether.takeCareOfInherit(putTogether.bySpacesOmitDefaults),
      defaultValue: 'outside', // can't use 'disc' because that'd override default 'decimal' for <ol>
      shortestValue: 'none'
    },
    'list-style-type' : {
      canOverride: canOverride.always,
      shortestValue: 'none',
      defaultValue: '__hack'
      // NOTE: we can't tell the real default value here, it's 'disc' for <ul> and 'decimal' for <ol>
      //       -- this is a hack, but it doesn't matter because this value will be either overridden or it will disappear at the final step anyway
    },
    'list-style-position' : {
      canOverride: canOverride.always,
      defaultValue: 'outside',
      shortestValue: 'inside'
    },
    'list-style-image' : {
      canOverride: canOverride.always,
      defaultValue: 'none'
    },
    // outline ------------------------------------------------------------------------------
    'outline': {
      components: [
        'outline-color',
        'outline-style',
        'outline-width'
      ],
      breakUp: breakUp.outline,
      putTogether: putTogether.takeCareOfInherit(putTogether.bySpacesOmitDefaults),
      defaultValue: '0'
    },
    'outline-color': {
      canOverride: canOverride.color,
      defaultValue: 'invert',
      shortestValue: 'red'
    },
    'outline-style': {
      canOverride: canOverride.always,
      defaultValue: 'none'
    },
    'outline-width': {
      canOverride: canOverride.unit,
      defaultValue: 'medium',
      shortestValue: '0'
    },
    // transform
    '-moz-transform': {
      canOverride: canOverride.sameFunctionOrValue
    },
    '-ms-transform': {
      canOverride: canOverride.sameFunctionOrValue
    },
    '-webkit-transform': {
      canOverride: canOverride.sameFunctionOrValue
    },
    'transform': {
      canOverride: canOverride.sameFunctionOrValue
    }
  };

  var addFourValueShorthand = function (prop, components, options) {
    options = options || {};
    processable[prop] = {
      components: components,
      breakUp: options.breakUp || breakUp.fourUnits,
      putTogether: options.putTogether || putTogether.takeCareOfInherit(putTogether.fourUnits),
      defaultValue: options.defaultValue || '0',
      shortestValue: options.shortestValue
    };
    for (var i = 0; i < components.length; i++) {
      processable[components[i]] = {
        breakUp: options.breakUp || breakUp.fourUnits,
        canOverride: options.canOverride || canOverride.unit,
        defaultValue: options.defaultValue || '0',
        shortestValue: options.shortestValue
      };
    }
  };

  ['', '-moz-', '-o-', '-webkit-'].forEach(function (prefix) {
    addFourValueShorthand(prefix + 'border-radius', [
      prefix + 'border-top-left-radius',
      prefix + 'border-top-right-radius',
      prefix + 'border-bottom-right-radius',
      prefix + 'border-bottom-left-radius'
    ], {
      breakUp: breakUp.borderRadius,
      putTogether: putTogether.borderRadius
    });
  });

  addFourValueShorthand('border-color', [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color'
  ], {
    breakUp: breakUp.fourBySpacesOrFunctions,
    canOverride: canOverride.color,
    defaultValue: 'currentColor',
    shortestValue: 'red'
  });

  addFourValueShorthand('border-style', [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style'
  ], {
    breakUp: breakUp.fourBySpaces,
    canOverride: canOverride.always,
    defaultValue: 'none'
  });

  addFourValueShorthand('border-width', [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width'
  ], {
    defaultValue: 'medium',
    shortestValue: '0'
  });

  addFourValueShorthand('padding', [
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left'
  ]);

  addFourValueShorthand('margin', [
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left'
  ]);

  // Set some stuff iteratively
  for (var proc in processable) {
    if (!processable.hasOwnProperty(proc))
      continue;

    var currDesc = processable[proc];

    if (!(currDesc.components instanceof Array) || currDesc.components.length === 0)
      continue;

    currDesc.isShorthand = true;

    for (var cI = 0; cI < currDesc.components.length; cI++) {
      if (!processable[currDesc.components[cI]]) {
        throw new Error('"' + currDesc.components[cI] + '" is defined as a component of "' + proc + '" but isn\'t defined in processable.');
      }
      processable[currDesc.components[cI]].componentOf = proc;
    }
  }

  var Token = tokenModule.createTokenPrototype(processable);

  return {
    implementedFor: /background|border|color|list|margin|outline|padding|transform/,
    processable: processable,
    Token: Token
  };
})();
