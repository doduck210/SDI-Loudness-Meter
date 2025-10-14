#pragma once

#include <algorithm>
#include <vector>
#include <string>
#include <memory>
#include <iostream>
#include <atomic>

extern "C" {
#include <libavcodec/avcodec.h>
}

#include <rtc/frameinfo.hpp>
#include <rtc/rtc.hpp>		 // libdatachannel C++ API
#include <nlohmann/json.hpp> // signaling 메시지 직렬화(편의를 위해)

// Forward declaration for AVPacket - REMOVED
// struct AVPacket;

using json = nlohmann::json;

struct AnnexbFrame {
	std::vector<uint8_t> data;   // Annex-B bytestream to send
	bool isIDR = false;
	bool hasSPS = false;
	bool hasPPS = false;
};

static const char* nal_name(uint8_t t)
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

inline std::atomic<bool> offerInFlight{ false };

inline std::atomic<bool> started{ false };

class WebRTC {
public:
	bool ready() const {
		return videoTrack_ && videoTrack_->isOpen();
	}

	WebRTC(const std::string& name/*, const std::string& stream_id*/) {
		cfg_.iceServers.clear();
		cfg_.enableIceTcp = false;
		cfg_.enableIceUdpMux = true;

		videoDesc_.setDirection(rtc::Description::Direction::SendOnly);
		videoDesc_.addH264Codec(96, "profile-level-id=42c01f;packetization-mode=1;level-asymmetry-allowed=1");
		videoDesc_.addExtMap(rtc::Description::Entry::ExtMap(1, "urn:ietf:params:rtp-hdrext:sdes:mid"));

		pc_ = std::make_shared<rtc::PeerConnection>(cfg_);

		videoTrack_ = pc_->addTrack(videoDesc_);

		rtpConfig_ = std::make_shared<rtc::RtpPacketizationConfig>(42, "video-send", 96, 90000);

		auto videoSendingSession = std::make_shared<rtc::H264RtpPacketizer>(rtc::H264RtpPacketizer::Separator::LongStartSequence, rtpConfig_);
		videoSendingSession->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtpConfig_));
		videoSendingSession->addToChain(std::make_shared<rtc::RtcpNackResponder>());
		videoTrack_->setMediaHandler(videoSendingSession);

		const std::string ws_url = "ws://127.0.0.1:8080/?role=pub";

		ws_ = std::make_shared<rtc::WebSocket>();

		ws_->onMessage([&](rtc::message_variant data)
			{
				auto handle_json = [&](const std::string& msg) {
					// 기존 JSON 처리 로직 (parse -> type 스위치 등)
					auto j = json::parse(msg, nullptr, false);
					if (j.is_discarded()) return;
					const std::string type = j.value("type", "");

					if (type == "need-offer") {
						if (offerInFlight.load()) return;
						offerInFlight = true;
						pc_->setLocalDescription(rtc::Description::Type::Offer);
						return;
					}
					if (type == "offer") {
						auto sdp = j.value("sdp", "");
						if (!sdp.empty()) {
							pc_->setRemoteDescription(rtc::Description(sdp, "offer"));
							pc_->setLocalDescription(); // answer 생성
						}
						return;
					}

					if (type == "answer") {
						rtc::Description answer(j["sdp"].get<std::string>(), j["type"].get<std::string>());
						pc_->setRemoteDescription(answer);
						return;
					}
					else if (type == "candidate") {
						const std::string cand = j.at("candidate").get<std::string>();
						const std::string mid = j.value("mid", "");

						pc_->addRemoteCandidate(rtc::Candidate{ cand, mid });
						return;
					}
					};

				if (auto ps = std::get_if<rtc::string>(&data)) {
					// 문자열은 그대로 사용
					handle_json(*ps);
				}
				else if (auto pb = std::get_if<rtc::binary>(&data)) {
					// ✅ std::byte → char* 로 재해석하여 문자열 생성 (핵심 포인트)
					const char* p = reinterpret_cast<const char*>(pb->data());
					std::string msg(p, pb->size());
					handle_json(msg);
				}
			});

				ws_->onOpen([&]()
					{
						std::cout << "Opened.\n";
					});
				ws_->open(ws_url);

				pc_->onLocalDescription([&](rtc::Description d) {
					std::string s = std::string(d);
					auto ml = s.find("\nm=video ");
					if (ml != std::string::npos) {
						auto nl = s.find('\n', ml + 1);
						std::cerr << "[M-LINE] " << s.substr(ml + 1, nl - (ml + 1)) << "\n";
					}
					ws_->send(json{ {"type", d.typeString()}, {"sdp", s} }.dump());
					});

				pc_->onLocalCandidate([&](rtc::Candidate c)
					{
						std::cerr << "[pc] onLocalCandidate mid=" << c.mid() << "\n";
						std::string cand = std::string(c);        // 예: "a=candidate:1 1 UDP ..."

						if (cand.rfind("a=", 0) == 0) cand.erase(0, 2);

						json m = {
						{"type", "candidate"},
						{"candidate", cand},                    // "candidate:2 1 UDP ..."
						{"mid", "video"},                       // 참고용
						{"sdpMLineIndex", 0}                    // ✅ 매핑 확정
						};

						ws_->send(m.dump()); });

				pc_->onStateChange([](rtc::PeerConnection::State s)
					{
						std::cerr << "[pc] state=" << static_cast<int>(s) << std::endl;
					});
				pc_->onGatheringStateChange([](rtc::PeerConnection::GatheringState g)
					{
						std::cerr << "[pc] gathering=" << static_cast<int>(g) << std::endl;
					});

				pc_->onSignalingStateChange([&](rtc::PeerConnection::SignalingState s) {
					if (s == rtc::PeerConnection::SignalingState::Stable) {
						offerInFlight = false;
					}
				});
	};

	void addVideoSender(const std::string& mid,
		const std::string& msid_stream,
		const std::string& msid_track,
		uint32_t ssrc)
	{
		rtc::Description::Video desc(mid, rtc::Description::Direction::SendOnly);
		desc.addH264Codec(96, "profile-level-id=42c01f;packetization-mode=1;level-asymmetry-allowed=1");
		desc.addExtMap(rtc::Description::Entry::ExtMap(1, "urn:ietf:params:rtp-hdrext:sdes:mid"));
		desc.addSSRC(ssrc, msid_track, msid_stream, "v0");

		auto track = pc_->addTrack(desc);

		auto rtp = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, msid_track, 96, 90000);
		auto h264 = std::make_shared<rtc::H264RtpPacketizer>(
			rtc::H264RtpPacketizer::Separator::LongStartSequence, rtp);
		h264->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtp));
		h264->addToChain(std::make_shared<rtc::RtcpNackResponder>());
		track->setMediaHandler(h264);

		Sender s;
		s.track = track;
		s.rtp = rtp;
		s.ts90k = 0;
		s.rtp_tick = 3003; // 90k / 29.97
		senders_.emplace(mid, std::move(s));
	}

	// 인코더 콜백에서 호출: 특정 mid로 패킷 전송
	void sendEncoded(const std::string& mid, const AVPacket* pkt)
	{
		auto it = senders_.find(mid);
		if (it == senders_.end()) return;
		auto& s = it->second;
		if (!s.track || !s.track->isOpen()) return;

		auto anxb = prepare_annexb_with_spspps(pkt->data, pkt->size);

		rtc::FrameInfo fi(s.ts90k);
		fi.payloadType = 96;

		s.rtp->timestamp = s.ts90k;
		s.ts90k += s.rtp_tick;

		const std::byte* buf = reinterpret_cast<const std::byte*>(anxb.data.data());
		s.track->sendFrame(buf, anxb.data.size(), fi);
	}


	//void sendEncoded(const AVPacket* pkt) {
	//	if (!ready())return;

	//	frames++;
	//	auto anxb = prepare_annexb_with_spspps(pkt->data, pkt->size);

	//	debug_log("webrtc send size=" + std::to_string(anxb.data.size()));

	//	std::cout << "sending\n";
	//	rtc::FrameInfo fi(ts90k);
	//	fi.payloadType = 96;
	//	rtpConfig_->timestamp = ts90k;
	//	ts90k += rtp_tick;

	//	videoTrack_->sendFrame(reinterpret_cast<const rtc::byte*>(anxb.data.data()), anxb.data.size(), fi);
	//}

private:
	struct Sender {
		std::shared_ptr<rtc::Track> track;
		std::shared_ptr<rtc::RtpPacketizationConfig> rtp;
		uint32_t ts90k = 0;
		uint32_t rtp_tick = 3003;
	};

	std::unordered_map<std::string, Sender> senders_;

	rtc::Configuration cfg_;
	inline static std::vector<uint8_t> g_sps_b{};
	inline static std::vector<uint8_t> g_pps_b{};
	rtc::Description::Video videoDesc_;
	std::shared_ptr<rtc::PeerConnection> pc_;
	std::shared_ptr<rtc::Track> videoTrack_;
	std::shared_ptr<rtc::RtpPacketizationConfig> rtpConfig_;

	std::shared_ptr<rtc::WebSocket> ws_;
	const std::string ws_url = "ws://127.0.0.1:8080/?role=pub";

	const int fps = 30;
	const uint32_t rtp_tick = 90000 / fps;
	uint32_t ts90k = 0;
	uint64_t frames = 0;

	static void split_annexb(const uint8_t* in, size_t n,
		std::vector<std::pair<const uint8_t*, size_t>>& out) {
		auto sc = [&](size_t i)->int {
			if (i + 3 <= n && in[i] == 0 && in[i + 1] == 0 && in[i + 2] == 1) return 3;
			if (i + 4 <= n && in[i] == 0 && in[i + 1] == 0 && in[i + 2] == 0 && in[i + 3] == 1) return 4;
			return 0;
			};
		size_t i = 0;
		while (i + 3 < n) {
			int k = sc(i);
			if (!k) { ++i; continue; }
			size_t nal_start = i + k;
			size_t j = nal_start;
			while (j + 3 < n && sc(j) == 0) ++j;
			size_t nal_size = j - nal_start;
			if (nal_size > 0) out.emplace_back(in + nal_start, nal_size);
			i = j;
		}
	}

	static AnnexbFrame prepare_annexb_with_spspps(const uint8_t* pkt, size_t pkt_size) {
		AnnexbFrame f;
		std::vector<std::pair<const uint8_t*, size_t>> nalus;
		split_annexb(pkt, pkt_size, nalus);

		auto push_sc = [&](std::vector<uint8_t>& v) {
			static const uint8_t sc[4] = { 0,0,0,1 };
			v.insert(v.end(), sc, sc + 4);
			};

		// 스캔하며 상태 파악 + SPS/PPS 캐시
		for (auto& it : nalus) {
			const uint8_t* p = it.first; size_t n = it.second;
			if (!n) continue;
			uint8_t t = p[0] & 0x1F;
			if (t == 9) continue; // AUD 제거
			if (t == 5) f.isIDR = true;
			if (t == 7) { f.hasSPS = true; g_sps_b.assign(p, p + n); }
			if (t == 8) { f.hasPPS = true; g_pps_b.assign(p, p + n); }
		}

		// IDR인데 AU에 SPS/PPS가 없으면 캐시된 SPS/PPS를 앞에 붙임
		if (f.isIDR && !(f.hasSPS && f.hasPPS)) {
			if (!g_sps_b.empty()) { push_sc(f.data); f.data.insert(f.data.end(), g_sps_b.begin(), g_sps_b.end()); }
			if (!g_pps_b.empty()) { push_sc(f.data); f.data.insert(f.data.end(), g_pps_b.begin(), g_pps_b.end()); }
		}

		// 나머지 NAL들 순서대로 부착
		for (auto& it : nalus) {
			const uint8_t* p = it.first; size_t n = it.second;
			uint8_t t = p[0] & 0x1F;
			if (t == 9) continue;
			push_sc(f.data);
			f.data.insert(f.data.end(), p, p + n);
		}

		return f;
	}
};
