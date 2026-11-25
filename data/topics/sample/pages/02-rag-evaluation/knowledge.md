# Retrieval and Evaluation

## Chunking and Locating Evidence {#chunk-evidence}

Retrieval-augmented generation (RAG) first retrieves external material and then uses the relevant content as the basis for generating an answer. Chunking determines the unit of retrieval: chunks that are too small tend to lose their premises, while chunks that are too large tend to pull in irrelevant information and take up context. Split along semantic boundaries such as headings, paragraphs or steps, then test the result with concrete questions.

Each chunk should keep metadata such as its source, section location and version, so that the system can locate evidence, generate citations and track outdated content when the material is updated. Citing a document does not mean the document supports every conclusion in the answer; the specific passages still need to be checked.

> Interview answer: Chunking has to balance semantic completeness against retrieval precision, and metadata takes care of location and updates. In the end, the system must not only find the material but also be able to show which piece of evidence supports the answer.

For the basic concept, see the [original RAG paper](https://arxiv.org/abs/2005.11401).

## Recall and Context Selection {#retrieval-quality}

Recall is about whether the evidence needed to answer the question was found; context selection is about which candidates are worth passing to the model. Taking more of the retriever's top candidates (top-k) is not always better: adding candidates may bring back missing evidence, but it also brings in duplicate, irrelevant or outdated material and raises generation latency and cost.

Retrieval results can be checked against labeled required evidence, then deduplicated and filtered for versions that do not apply, with reranking where necessary. Debugging should start by checking whether the candidates contain the key evidence: if it was not found, check the index and the query; if it was found but the answer is still wrong, check how the context is organized and the generation step. Simply switching to a different generation model is no guarantee of fixing missing retrieval.

> Interview answer: I first check whether the required evidence was recalled, then the context the model received and the final answer; the number of candidates should be set through actual evaluation.

## End-to-End Regression Evaluation {#end-to-end-eval}

End-to-end evaluation tests the overall outcome, from the user asking a question to the task being completed. Regression evaluation uses a relatively fixed set of test cases to check whether a change improves the target behavior and whether it makes existing capabilities regress. The test cases should include at least normal questions, questions whose answer is missing from the material, and questions asked after a document update; when evidence is missing, the expected behavior is to state the limitation or ask for more information.

Evaluation cannot look only at whether answers are fluent; it should also check task completion, whether facts and citations are supported by evidence, and latency and cost. When changing the chunking strategy, the retrieval configuration or the prompt, record the configuration under test and the material version, and compare the results on the same set of test cases. Automatic scoring can help with screening, but critical failures still need human verification.

> Interview answer: Compare the complete pipeline on fixed scenarios that cover normal cases, missing evidence and updates, and weigh quality, latency and cost together to decide whether a change is worth shipping.
