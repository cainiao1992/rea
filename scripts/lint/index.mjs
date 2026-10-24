import noBufferDeepEquality from "./no-buffer-deep-equality.mjs";
import cancellationCause from "./cancellation-cause.mjs";

export default {
  meta: { name: "rea" },
  rules: {
    "no-buffer-deep-equality": noBufferDeepEquality,
    "cancellation-cause": cancellationCause,
  },
};
