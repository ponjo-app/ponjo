#

# Nebius x Nvidia Hackthon Proposal

## Project Name

Ponjo: <https://github.com/>

## **Elevator pitch**

> Provide a short tagline for the project. 

Co-write with AI agents powered NVIDIA Nemotron just like you do with your teammates

## **About the project**

> Be sure to write what inspired you, what you learned, how you built your project, and the challenges you faced.

**Track:** Best Apps and Agents

Today, most AI agents write documents in a delegate mode: you prompt the agent, it returns a draft, and you review it and send feedback as more prompts. This loop is slow and opaque. In my open-source text editor, Ponjo, I redesigned the co-writing agent's UX and runtime around a "peer" mode. In the UX, you and multiple personalized agents work in the same doc in real time, using a familiar writing and editing interface. In the runtime, each agent sees the same context as the human and edits through the same read and write APIs, so it sees and acts just like a remote collaborator.

Nebius Token Factory and NVIDIA Nemotron 3 Super make this experience possible. Token Factory provides a serverless endpoint for LLM inference, and Nemotron delivers the capability and speed the agent needs at a low cost.

## Built during the hackathon

I built an agent runtime that runs on Nemotron (and also supports Anthropic and OpenAI-compatible models). It rests on two principles:

1. **Same context, same tools.** The agent sees what a human user sees and acts only through the same tools: read, find, grep, and propose (an edit or a comment). Its behavior is therefore consistent and transparent: whatever it does, you or another user could have done from the same screen.
2. **Stateless runs.** An agent run is a pure function of the document and its comment thread. Because all state lives in the shared document rather than in an agent's private memory, every run can be interrupted, resumed, or replayed from the document alone.

I also added Nebius Token Factory as an LLM provider in the app's agent settings, and built an online preview page where users can co-write with a Nemotron-powered agent.

Challenges during the hackthon

I face 2 challenges when designing my agent runtime for my co-writing experience:

First is to make the AI agent interact as the human being. Initially I create private APIs and private memories for agent to comment, read and edit the doc. However, I realize this makes the agent behaves differently from a real human co-writer. To fix this, the agent runtime forces each agent run to view the same context (docs, comment threads) and use the same APIs as the human users.