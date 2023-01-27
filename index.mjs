// wow this code sucks

import express from "express";
import {verifyKeyMiddleware} from "discord-interactions";
import dotenv from "dotenv";
import querystring from "querystring";
import { PrismaClient } from "@prisma/client";

function getTimestamp(snowflake) {
	return Number((BigInt(snowflake) >> BigInt(22)) + 1420070400000n);
}

const prisma = new PrismaClient();
const url = new URL("https://discord.com/oauth2/authorize");
url.searchParams.set("client_id", process.env.APP_ID);
url.searchParams.set("redirect_uri", process.env.REDIRECT);
url.searchParams.set("response_type", "code");
url.searchParams.set("scope", "identify guilds role_connections.write");
url.searchParams.set("prompt", "none");


dotenv.config();
const app = express();

async function refresh(user) {
	const userObj = await prisma.user.findUnique({
		where: {
			id: user
		}
	});
	if (!userObj) {
		return [false, 0];
	}

	if (((new Date) - userObj.lastCheckedAt) < 1000 * 60) {
		return [false, 1];
	}

	const response = await fetch("https://discord.com/api/v10/oauth2/token", {
		method: "POST",
		body: querystring.stringify({
			client_id: process.env.APP_ID,
			client_secret: process.env.SECRET,
			grant_type: "refresh_token",
			refresh_token: userObj.refreshToken,
		}),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded"
		}
	});
	if (!response.ok) {
		return [false, 2];
	}

	const body = await response.json();
	if (!body.token_type || !body.access_token || !body.refresh_token || !(body.token_type === "Bearer")) {
		return [false, 2];
	}

	const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
		headers: {
			"Authorization": `Bearer ${body.access_token}`
		}
	});

	const userBody = await userResponse.json();

	const guildResponse = await fetch("https://discord.com/api/v10/users/@me/guilds", {
		headers: {
			"Authorization": `Bearer ${body.access_token}`
		}
	});

	const guildBody = await guildResponse.json();

	const guilds = guildBody.length;
	const nitro = (userBody.premium_type > 0) ? 1 : 0;
	const mfa = userBody.mfa_enabled ? 1 : 0;
	const partner = Boolean(userBody.flags & (1 << 2)) ? 1 : 0;
	const age = (new Date(getTimestamp(userBody.id))).toISOString();

	await prisma.user.update({
		where: {
			id: user
		},
		data: {
			refreshToken: body.refresh_token,
			lastCheckedAt: new Date()
		}
	});

	const finalFetchResp = await fetch("https://discord.com/api/v10/users/@me/applications/" + process.env.APP_ID + "/role-connection", {
		method: "PUT",
		body: JSON.stringify({
			platform_name: "Discord",
			platform_username: userBody.username + "#" + userBody.discriminator,
			metadata: {
				guilds,
				nitro,
				mfa,
				partner,
				age
			}
		}),
		headers: {
			"Authorization": `Bearer ${body.access_token}`,
			"Content-Type": "application/json"
		}
	});

	return [true];
}
async function wrefresh(user, token) {
	const data = await refresh(user);

	let f = {};
	if (data[0] === false) {
		let msg = {
			0: "You are not authenticated. Go to " + url + " to authenticate.",
			1: "You are being ratelimited. Please wait a minute before trying again.",
			2: "There was an error authenticating you. Try reauthenticating at " + url + "."
		}
		f = {
				content: msg[data[1]]
		}
	} else {
		f = {
				content: "Success"
		}
	}

	console.log(f, data);
	const rdata = await fetch("https://discord.com/api/v10/webhooks/" + process.env.APP_ID + "/" + token + "/messages/@original", {
		method: "PATCH",
		body: JSON.stringify(f),
		headers: {
			"Content-Type": "application/json"
		}
	});
}

app.get("/", (req, res) => {
	  res.send("Hello World!");
});

app.post("/interaction",  verifyKeyMiddleware(process.env.PUBKEY) , async (req, res) => {
	if (req.body.data && req.body.data.name === "refresh") {
		wrefresh(req.body.member.user.id, req.body.token);
		res.json({
			type: 5,
			data: {
				flags: 64
			}
		});
	}
});

app.get("/oauth", async (req, res) => {
	console.log("req to oauth!");
	const response = await fetch("https://discord.com/api/v10/oauth2/token", {
		method: "POST",
		body: querystring.stringify({
			client_id: process.env.APP_ID,
			client_secret: process.env.SECRET,
			grant_type: "authorization_code",
			code: req.query.code,
			state: req.query.state,
			redirect_uri: process.env.REDIRECT,
			scope: "identify guilds role_connections.write"
		}),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded"
		}
	});

	if (response.status !== 200) {
		return res.end("Login failed")
	}

	const body = await response.json();
	if (!body.token_type || !body.access_token || !body.refresh_token || !(body.token_type === "Bearer")) {
		return res.end("Login failed")
	}

	const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
		headers: {
			"Authorization": `Bearer ${body.access_token}`
		}
	});

	if (userResponse.status !== 200) {
		return res.end("Login failed")
	}

	const userBody = await userResponse.json();

	await prisma.user.upsert({
		where: {
			id: userBody.id
		},
		create: {
			id: userBody.id,
			refreshToken: body.refresh_token,
			lastCheckedAt: new Date(0)
		},
		update: {
			refreshToken: body.refresh_token,
			lastCheckedAt: new Date(0)
		}
	});

	await refresh(userBody.id);

	res.setHeader("Content-Type", "text/html");
	res.end(`<script>window.close()</script>Go away`);
});

app.get("/role", (req, res) => {
	res.redirect(307, url.toString());
});

app.get("/" + process.env.SETUP_SECRET, async (req, res) => {
	const resp = await fetch("https://discord.com/api/v9/applications/" + process.env.APP_ID + "/commands", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": "Bot " + process.env.BOT_TOKEN
		},
		body: JSON.stringify({
			name: "refresh",
			description: "Refreshes your linked status"
		})
	});
	const resp2 = await fetch("https://discord.com/api/v9/applications/" + process.env.APP_ID + "/role-connections/metadata", {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"Authorization": "Bot " + process.env.BOT_TOKEN
		},
		body: JSON.stringify([
			{
				type: 7, //BOOLEAN_EQUAL
				name: "2 Factor Authentication",
				description: "Has 2-Factor Authentication enabled",
				key: "mfa"
			},
			{
				type: 7,
				name: "Partner",
				description: "Is a Discord Partner",
				key: "partner"
			},
			{
				type: 7,
				name: "Has Nitro",
				description: "Has Discord Nitro",
				key: "nitro"
			},
			{
				type: 6, // DATETIME_LESS_THAN_OR_EQUAL
				name: "Account Age",
				description: "The user's account was created before",
				key: "age"
			},
			{
				type: 2, // INTEGER_GREATER_THAN_OR_EQUAL
				name: "Guild count",
				description: "The user is in more than X guilds",
				key: "guilds"
			}
		])
	})
	if (!resp.ok) return res.status(500).send("Error: " + resp.status);
	if (!resp2.ok) return res.status(500).send("Error: " + resp2.status);
	res.send("Done!");
});

console.log(`https://discord.com/api/oauth2/authorize?client_id=${process.env.APP_ID}&permissions=0&scope=applications.commands%20bot`);

app.listen(6060);