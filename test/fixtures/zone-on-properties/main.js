/* global window */
// zone.js's on-property patch (packages/zone.js/lib/browser/property-descriptor.js and lib/common/utils.js), cut
// down: `propertyDescriptorPatch` redefines every `on…` property of the window that a page-set ignore list doesn't
// name.
var ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var ObjectDefineProperty = Object.defineProperty;
var ObjectGetPrototypeOf = Object.getPrototypeOf;
function patchProperty(obj, prop, prototype) {
  let desc = ObjectGetOwnPropertyDescriptor(obj, prop);
  if (!desc && prototype) {
    const prototypeDesc = ObjectGetOwnPropertyDescriptor(prototype, prop);
    if (prototypeDesc) {
      desc = { enumerable: true, configurable: true };
    }
  }
  if (!desc || !desc.configurable) {
    return;
  }
  delete desc.writable;
  delete desc.value;
  const originalDescGet = desc.get;
  const eventName = prop.slice(2);
  desc.set = function(newValue) {
    this.addEventListener(eventName, newValue, false);
  };
  desc.get = function() {
    return originalDescGet ? originalDescGet.call(this) : null;
  };
  ObjectDefineProperty(obj, prop, desc);
}
function patchOnProperties(obj, properties, prototype) {
  if (properties) {
    for (let i = 0; i < properties.length; i++) {
      patchProperty(obj, "on" + properties[i], prototype);
    }
  }
}
function filterProperties(target, onProperties, ignoreProperties) {
  if (!ignoreProperties || ignoreProperties.length === 0) {
    return onProperties;
  }
  const tip = ignoreProperties.filter((ip) => ip.target === target);
  if (tip.length === 0) {
    return onProperties;
  }
  const targetIgnoreProperties = tip[0].ignoreProperties;
  return onProperties.filter((op) => targetIgnoreProperties.indexOf(op) === -1);
}
function patchFilteredProperties(target, onProperties, ignoreProperties, prototype) {
  if (!target) {
    return;
  }
  const filteredProperties = filterProperties(target, onProperties, ignoreProperties);
  patchOnProperties(target, filteredProperties, prototype);
}
function getOnEventNames(target) {
  return Object.getOwnPropertyNames(target).filter((name) => name.startsWith("on") && name.length > 2).map((name) => name.substring(2));
}
function propertyDescriptorPatch(_global2) {
  const ignoreProperties = _global2["__Zone_ignore_on_properties"];
  const internalWindow2 = window;
  patchFilteredProperties(internalWindow2, getOnEventNames(internalWindow2), ignoreProperties, ObjectGetPrototypeOf(internalWindow2));
}
propertyDescriptorPatch(window);
