#pragma once
#pragma once

#include <algorithm>
#include <vector>

#include <condition_variable>
#include <deque>
#include <chrono>

struct EncodedItem
{
	std::vector<uint8_t> annexb;
	uint32_t ts90k = 0;
	bool keyframe = false;
}

// #include "Filter.h"

extern "C"
{
#include <libavcodec/avcodec.h>
}

#include <rtc/frameinfo.hpp>
#include <rtc/rtc.hpp>
#include <nlohmann/json.hpp>

#include <mutex>

using json = nlohmann::json;

struct Sender
{
	std::shared_ptr<rtc::Track> track;
	std::shared_ptr<rtc::RtpPacketizationConfig> rtp;

	bool haveBase = false;
	int64_t basePts = 0;
	uint32_t baseTs90k = 0;
	std::chrono::steady_clock::time_point baseWall;

	uint32_t lastTs90k = 0;

	std::deque<EncodedItem> q;
};

struct Peer
{
	std::shared_ptr<rtc::PeerConnection> pc;
	std::unordered_map<std::string, Sender> senders;
	bool offerInFlight = false;
};

struct TrackTemplate
{
	std::string mid, stream, track;
	uint32_t ssrc = 0;
	uint32_t rtp_tick = 3003;
	uint32_t clock = 90000;
	uint8_t payloadType = 96;
};
struct AnnexbFrame
{
	std::vector<uint8_t> data;
	bool isIDR = false;
	bool hasSPS = false;
	bool hasPPS = false;
};

static const char *nal_name(uint8_t t)
{
	switch (t)
	{
	case 1:
		return "NonIDR";
	case 5:
		return "IDR";
	case 6:
		return "SEI";
	case 7:
		return "SPS";
	case 8:
		return "PPS";
	case 9:
		return "AUD";
	default:
		return "NAL";
	}
}

inline std::atomic<bool> offerInFlight{false};

inline std::atomic<bool> started{false};

class WebRTC
{
public:
	bool RegisterH264Track(const std::string &mid, const std::string &msid_stream, const std::string &msid_track, uint32_t ssrc, uint32_t rtp_tick = 3003)
	{
		// std::lock_guard<std::mutex> lk(mx_);

		if (trackTemplates_.count(mid))
		{
			return false;
		}

		TrackTemplate t;
		t.mid = mid;
		t.stream = msid_stream;
		t.track = msid_track;
		t.ssrc = ssrc;
		t.payloadType = 96;
		t.clock = 90000;
		t.rtp_tick = rtp_tick;
		trackTemplates_.emplace(mid, std::move(t));

		for (auto &[viewerId, P] : peers_)
		{
			if (!P.senders.count(mid))
			{
				AddVideoSenderToPeerUnlocked(P, trackTemplates_.at(mid));
			}

			if (P.pc && P.pc->state() == rtc::PeerConnection::State::Connected)
			{
				if (!P.offerInFlight)
				{
					P.offerInFlight = true;
					P.pc->setLocalDescription(rtc::Description::Type::Offer);
				}
			}
		}
		return true;
	}

	bool UnregisterTrack(const std::string &mid)
	{
		// std::lock_guard<std::mutex> lk(mx_);
		if (!trackTemplates_.erase(mid))
		{
			return false;
		}

		for (auto &[viewerId, P] : peers_)
		{
			if (auto it = P.senders.find(mid); it != P.senders.end())
			{
				if (it->second.track)
				{
					it->second.track->close();
					P.senders.erase(it);
				}
			}
		}
		return true;
	}

	WebRTC(const std::string &name)
	{
		cfg_.iceServers.clear();
		cfg_.enableIceTcp = false;
		cfg_.enableIceUdpMux = true;

		// pc_ = std::make_shared<rtc::PeerConnection>(cfg_);

		const std::string ws_url = "ws://127.0.0.1:8080/?role=pub";

		ws_ = std::make_shared<rtc::WebSocket>();

		ws_->onMessage([&](rtc::message_variant data)
					   {
				auto handle_json = [&](const std::string& msg) {
					auto j = json::parse(msg, nullptr, false);
					if (j.is_discarded()) {
						return;
					};

					const std::string type = j.value("type", "");
					const std::string room = j.value("room", "default");
					const std::string to = j.value("to", "");
					const std::string from = j.value("from", "");

					if (type == "need-offer") {
						const std::string viewerId = j.at("to").get<std::string>();
						EnsurePeer(viewerId);
						auto& P = peers_.at(viewerId);
						if (P.offerInFlight) {
							return;
						}
						P.offerInFlight = true;
						P.pc->setLocalDescription(rtc::Description::Type::Offer);
						return;
					}
					else if (type == "answer") {
						const std::string viewerId = from;
						auto it = peers_.find(viewerId);
						if (it == peers_.end()) {
							return;
						}

						std::cerr << "[pc:" << viewerId << "] answer len=" << j["sdp"].get<std::string>().size() << "\n";

						rtc::Description answer(j["sdp"].get<std::string>(), "answer");
						it->second.pc->setRemoteDescription(answer);
						return;
					}
					else if (type == "candidate") {
						const std::string viewerId = from;
						auto it = peers_.find(viewerId);
						if (it == peers_.end()) {
							return;
						}
						const std::string cand = j.at("candidate").get<std::string>();
						const std::string mid = j.value("mid", "");
						it->second.pc->addRemoteCandidate(rtc::Candidate{ cand,mid });
						return;
					}
					};

				if (auto ps = std::get_if<rtc::string>(&data)) {
					handle_json(*ps);
				}
				else if (auto pb = std::get_if<rtc::binary>(&data)) {
					const char* p = reinterpret_cast<const char*>(pb->data());
					std::string msg(p, pb->size());
					handle_json(msg);
				} });

		ws_->onOpen([&]()
					{ std::cout << "Opened.\n"; });
		ws_->open(ws_url);

		StartSendWorker();
	};

	~WebRTC()
	{
		StopSendWorker();
	}

	void SendEncoded(const std::string &mid, const AVPacket *pkt, AVRational pktTimeBase)
	{
		AnnexbFrame anxb = PrepareAnnexBwithSpsPps(pkt->data, pkt->size);

		int64_t pts = (pkt->pts != AV_NOPTS_VALUE) ? pkt->pts : pkt->dts;
		if (pts == AV_NOPTS_VALUE)
		{
			return;
		}

		uint32_t ts90k = pts_to_90k(pts, pktTimeBase);

		std::lock_guard<std::mutex> lk(mx_);

		for (auto &[viewerId, P] : peers_)
		{
			auto it = P.senders.find(mid);
			if (it == P.senders.end())
			{
				continue;
			}
			auto &s = it->second;
			if (!s.track || !s.track->isOpen())
			{
				continue;
			}

			if (!s.haveBase)
			{
				s.basePts = pts;
				s.baseTs90k = ts90k;
				s.baseWall = std::chrono::steady_clock::now();
				s.haveBase = true;
				s.lastTs90k = ts90k;
			}

			if (ts90k <= s.lastTs90k)
			{
				ts90k = s.lastTs90k + 1;
			}

			EncodedItem item;
			item.ts90k = ts90k;
			item.keyframe = anxb.isIDR;
			item.annexb = std::move(anxb.data);

			constexpr size_t MAX_QUEUE = 90;
			if (s.q.size() >= MAX_QUEUE)
			{
				s.q.pop_front();
			}
			s.q.push_back(std::move(item));

			s.lastTs90k = ts90k;
		}

		cv_.notify_all();
	}

	void EnsurePeer(const std::string &viewerId)
	{
		// std::lock_guard<std::mutex> lk(mx_);

		if (peers_.count(viewerId))
		{
			return;
		}

		Peer P;
		P.pc = std::make_shared<rtc::PeerConnection>(cfg_);

		P.pc->onLocalDescription([&, viewerId](rtc::Description d)
								 {
			std::string s = std::string(d);
			ws_->send(json{ { "type",d.typeString() }, { "sdp",s }, { "to",viewerId } }.dump()); });

		P.pc->onLocalCandidate([&, viewerId](rtc::Candidate c)
							   {
			std::string cand = std::string(c);
			if (cand.rfind("a=", 0) == 0) {
				cand.erase(0, 2);
			}
			ws_->send(json{ {
					"type","candidate"},{"candidate",cand},{"mid",c.mid()},{"to",viewerId} }.dump()); });

		P.pc->onSignalingStateChange([&, viewerId](rtc::PeerConnection::SignalingState s)
									 {
			if (s == rtc::PeerConnection::SignalingState::Stable) {
				peers_[viewerId].offerInFlight = false;
			} });

		for (auto &[mid, tmpl] : trackTemplates_)
		{
			AddVideoSenderToPeerUnlocked(P, tmpl);
		}

		peers_.emplace(viewerId, std::move(P));

		peers_[viewerId].offerInFlight = true;
		peers_[viewerId].pc->setLocalDescription(rtc::Description::Type::Offer);
	}

	void AddVideoSenderToPeerUnlocked(Peer &P, const TrackTemplate &T)
	{
		if (!P.pc)
		{
			return;
		}

		if (P.senders.count(T.mid))
		{
			return;
		}

		rtc::Description::Video desc(T.mid, rtc::Description::Direction::SendOnly);
		desc.addH264Codec(96, "profile-level-id=42c01f;packetization-mode=1;level-asymmetry-allowed=1");
		desc.addExtMap(rtc::Description::Entry::ExtMap(1, "urn:ietf:params:rtp-hdrext:sdes:mid"));
		desc.addSSRC(T.ssrc, T.track, T.stream, "v0");

		auto track = P.pc->addTrack(desc);

		auto rtp = std::make_shared<rtc::RtpPacketizationConfig>(T.ssrc, T.track, T.payloadType, T.clock);
		auto h264 = std::make_shared<rtc::H264RtpPacketizer>(
			rtc::H264RtpPacketizer::Separator::LongStartSequence, rtp);
		h264->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtp));
		h264->addToChain(std::make_shared<rtc::RtcpNackResponder>());
		track->setMediaHandler(h264);

		Sender s;
		s.track = track;
		s.rtp = rtp;
		s.haveBase = false;
		P.senders.emplace(T.mid, std::move(s));
	}

private:
	std::mutex mx_;
	std::condition_variable cv_;
	std::thread sendThread_;
	bool stop_ = false;

	inline static std::vector<uint8_t> g_sps_b{};
	inline static std::vector<uint8_t> g_pps_b{};

	std::unordered_map<std::string, Peer> peers_;

	std::unordered_map<std::string, TrackTemplate> trackTemplates_;

	// std::mutex mx_;

	rtc::Configuration cfg_;

	std::shared_ptr<rtc::WebSocket> ws_;
	const std::string ws_url = "ws://127.0.0.1:8080/?role=pub&room=default";

	const int fps = 30;
	const uint32_t rtp_tick = 90000 / fps;
	uint32_t ts90k = 0;
	uint64_t frames = 0;

	void StartSendWorker()
	{
		sendThread_ = std::thread([this]()
								  { SendLoop(); });
	}

	void StopSendWorker()
	{
		std::lock_guard<std::mutex> lk(mx_);
		stop_ = true;

		cv_.notify_all();
		if (sehdThread_.joinable())
		{
			sendThread_.join();
		}
	}

	static inline uint32_t pts_to_90k(int64_t pts, AVRational tb)
	{
		return (uint32_t)av_rescale_q(pts, tb, AVRational{1, 90000});
	}

	void SendLoop()
	{
		using namespace std::chrono;

		std::unique_lock<std::mutex> lk(mx_);
		while (!stop_)
		{
			bool haveAny = false;
			steady_clock::time_point nextDue = steady_clock::time_point::max();

			for (auto &[viewerId, P] : peers_)
			{
				for (auto &[mid, s] : P.senders)
				{
					if (!s.track || !s.track->isOpen())
					{
						continue;
					}
					if (s.q.empty())
					{
						continue;
					}

					haveAny = true;

					auto &item = s.q.front();
					auto dt = duration_cast<steady_clock::duration>(duration<double>(double(item.ts90k - s.baseTs90k) / 90000.0));
					auto due = s.baseWall + dt;
					if (due < nextxDue)
					{
						nextDue = due;
					}
				}
			}

			if (!haveAny)
			{
				cv_.wait(lk, [&]
						 { return stop_ || HasQueuedUnlocked(); });
				continue;
			}

			auto now = steady_clock::now();
			if (nextDue > now)
			{
				cv_.wait_until(lk, nextDue, [&]
							   { return stop_; });
				continue;
			}

			now = steady_clock::now();
			for (auto &[viewerId, P] : peers_)
			{
				for (auto &[mid, s] : P.senders)
				{
					if (!s.track || !s.track->isOpen())
					{
						continue;
					}
					if (s.q.empty())
					{
						continue;
					}

					auto &item = s.q.front();
					auto dt = duration_cast<steady_clock::duration>(duration<double>(double(item.ts90k - s.baseTs90k) / 90000.0));
					auto due = s.baseWall + dt;
					if (due > now)
					{
						continue;
					}

					rtc::FrameInfo fi(s.ts90k);
					fi.payloadType = 96;

					s.rtp->timestamp = item.ts90k;

					const std::byte *buf = reinterpret_cast<const std::byte *>(item.annexb.data());
					s.track->sendFrame(buf, item.annexb.size(), fi);

					s.lastTs90k = item.ts90k;
					s.q.pop_front();
				}
			}
		}
	}

	bool HasQueuedUnlocked() const
	{
		for (auto const &[viewerId, P] : peers_)
		{
			for (auto const &[mid, s] : P.senders)
			{
				if (!s.q.empty())
				{
					return true;
				}
			}
		}
	}

	static void SplitAnnexB(const uint8_t *in, size_t n,
							std::vector<std::pair<const uint8_t *, size_t>> &out)
	{
		auto sc = [&](size_t i) -> int
		{
			if (i + 3 <= n && in[i] == 0 && in[i + 1] == 0 && in[i + 2] == 1)
				return 3;
			if (i + 4 <= n && in[i] == 0 && in[i + 1] == 0 && in[i + 2] == 0 && in[i + 3] == 1)
				return 4;
			return 0;
		};
		size_t i = 0;
		while (i + 3 < n)
		{
			int k = sc(i);
			if (!k)
			{
				++i;
				continue;
			}
			size_t nal_start = i + k;
			size_t j = nal_start;
			while (j + 3 < n && sc(j) == 0)
				++j;
			size_t nal_size = j - nal_start;
			if (nal_size > 0)
				out.emplace_back(in + nal_start, nal_size);
			i = j;
		}
	}

	static AnnexbFrame PrepareAnnexBwithSpsPps(const uint8_t *pkt, size_t pkt_size)
	{
		AnnexbFrame f;
		std::vector<std::pair<const uint8_t *, size_t>> nalus;
		SplitAnnexB(pkt, pkt_size, nalus);

		auto push_sc = [&](std::vector<uint8_t> &v)
		{
			static const uint8_t sc[4] = {0, 0, 0, 1};
			v.insert(v.end(), sc, sc + 4);
		};

		for (auto &it : nalus)
		{
			const uint8_t *p = it.first;
			size_t n = it.second;
			if (!n)
				continue;
			uint8_t t = p[0] & 0x1F;
			if (t == 9)
				continue; // AUD 제거
			if (t == 5)
				f.isIDR = true;
			if (t == 7)
			{
				f.hasSPS = true;
				g_sps_b.assign(p, p + n);
			}
			if (t == 8)
			{
				f.hasPPS = true;
				g_pps_b.assign(p, p + n);
			}
		}

		if (f.isIDR && !(f.hasSPS && f.hasPPS))
		{
			if (!g_sps_b.empty())
			{
				push_sc(f.data);
				f.data.insert(f.data.end(), g_sps_b.begin(), g_sps_b.end());
			}
			if (!g_pps_b.empty())
			{
				push_sc(f.data);
				f.data.insert(f.data.end(), g_pps_b.begin(), g_pps_b.end());
			}
		}

		for (auto &it : nalus)
		{
			const uint8_t *p = it.first;
			size_t n = it.second;
			uint8_t t = p[0] & 0x1F;
			if (t == 9)
				continue;
			push_sc(f.data);
			f.data.insert(f.data.end(), p, p + n);
		}

		return f;
	}
};