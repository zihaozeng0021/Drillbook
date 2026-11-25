# Tools and Task Execution

## Task Inputs and Completion Criteria {#task-contract}

A **task contract** turns the user's natural-language goal into explicit inputs, constraints and completion criteria. An agent that produces an answer or issues a tool call has not necessarily completed the business task; whether the task is done should be decided by results that can be checked.

Take "compile this week's meeting action items" as an example: the inputs should specify the meeting notes, the date range and where the output goes; a completion criterion can be that every action item can be traced back to the source text, and that an unclear owner is kept as "to be confirmed" rather than filled in by the agent.

| Contract element | Example |
| --- | --- |
| Required inputs | The meeting notes and this week's start and end dates |
| Output constraints | Item, owner, due date and source location |
| Completion criteria | All required fields present, unknown information explicitly marked |
| Exit conditions | Ask for more input when it is missing; report progress once the step or time limit is reached |

When required information is missing, first ask for clarification or return a partial result with its limitations stated; do not cover up incomplete input by calling tools over and over.

> Interview answer: I first define the inputs, constraints and verifiable completion criteria, and only then let the agent plan its steps. Producing a paragraph of text or issuing a call does not mean success; the result still has to be checked, and there must be exit paths for missing information and an exhausted budget.

## Tool Interfaces and Structured Parameters {#tool-contract}

A **tool contract** specifies what a tool does, which parameters it accepts and what result it returns. The model proposes a call, the application code validates it and executes the tool, and then hands the result back to the model; producing well-formed parameters does not mean the external operation has succeeded.

Parameters can be described with JSON Schema. Here is a simplified example for a meeting search interface:

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
  },
  "required": ["query", "limit"],
  "additionalProperties": false
}
```

`properties` describes the constraints on each field, and `required` declares the mandatory fields; a field that appears in `properties` does not automatically become required. The application must also validate the business meaning, for example whether the date range falls within the week the user specified, and must distinguish success, no match and execution failure. For the structure definitions, see the [JSON Schema reference on objects](https://json-schema.org/understanding-json-schema/reference/object).

> Interview answer: A tool description should state its capability, inputs and outputs explicitly. The schema first checks types, ranges and required fields, and business rules then check what the parameters mean; after execution, read the actual result instead of treating the call the model proposed as a success receipt.

## Retries and Idempotency {#retry-idempotency}

**Idempotency** means that executing the same logical operation repeatedly has the same effect on business state as executing it once. A network timeout only tells the caller that it did not receive the result in time; the server may already have completed the operation, so simply retrying "create action item" can produce duplicate items.

Each logical operation can be assigned a stable idempotency key, and the server stores the key, a digest of the parameters and the execution result. When the same key arrives again with the same parameters, the stored result is reused; when the same key comes with different parameters, a conflict should be reported. Idempotency requires deduplication and consistency guarantees on the server side; merely having the client send a string does not guarantee anything.

- Transient network failures can be retried within limits on the number of attempts and the time spent, usually with backoff and random jitter so that retries do not pile up at the same moment.
- Invalid parameters call for fixing the input first; retrying with the same bad parameters usually does not help.
- For a write operation whose status is unknown, first query the result by its operation ID, then decide whether to retry or hand it over for handling.

> Interview answer: A timeout is not the same as a failure. Write operations need a stable idempotency key and server-side deduplication, and the status should be queried first when necessary; retries should distinguish transient failures from parameter errors and be limited in number and time.
