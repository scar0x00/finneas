import type { ChatHistory } from "../types/Chat";
import type { Env } from "../index";
import type { AgentParams } from "../types/AgentParams";

export class Agent {
    SYSTEM: string;
    chatId: string;
    env: Env;
    model: string = "@cf/zai-org/glm-5.3-flash";
    history: ChatHistory;

    static async init({
        SYSTEM,
        chatId,
        env,
        model,
    }: AgentParams) {
        const agentParams: AgentParams = {
            SYSTEM,
            chatId,
            env,
        };
        if (model) agentParams.model = model;
        const agent = new Agent(agentParams);
        let chatJson = await agent.env.CHATS.get(agent.chatId);
        let history: ChatHistory;
        if (chatJson === null) {
            history = [
                {
                    role: "system",
                    content: agent.SYSTEM,
                },
            ];
        } else {
            history = JSON.parse(chatJson) as ChatHistory;
        }
        agent.history = history;

        return agent;
    }

    constructor({
        SYSTEM,
        chatId,
        env,
        model,
    }: AgentParams) {
        this.chatId = chatId.toString();
        this.env = env;
        if (model) this.model = model;
        this.SYSTEM = SYSTEM;
        this.history = [];
    }

    async run(userMssg: string) {
        const messages: ChatHistory = [
            ...this.history,
            {
                role: "user",
                content: userMssg,
            },
        ];

        const response = await this.env.AI.run(this.model, {
            messages: messages,
            chat_template_kwargs: {
                enable_thinking: true,
            },
        });

        if (!response.choices || !Array.isArray(response?.choices)){ 
            throw new Error("AI.run returned succefully, but the response object is malformed");
        }
        const answer = response?.choices[0].message.content;

        await this.env.CHATS.put(
            this.chatId,
            JSON.stringify([
                ...messages,
                {
                    role: "assistant",
                    content: answer,
                },
            ]),
        );
        return answer;
    }

    async clearChat() {
        let chatJson = await this.env.CHATS.delete(this.chatId);
    }
}
